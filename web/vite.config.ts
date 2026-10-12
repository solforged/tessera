import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig(({ mode }) => ({
  plugins: [solid(), ...(mode === 'demo' ? [demoOffline()] : [])],
  define: { __TESSERA_DEMO__: mode === 'demo', __TESSERA_ANDROID__: mode === 'android' },
  ...(mode === 'demo' ? {
    build: { outDir: 'dist-demo', rollupOptions: { input: 'demo.html' } },
    // The installable app's manifest and icons; not the native entry's offline worker.
    publicDir: 'public-demo',
    worker: { format: 'es' as const },
  } : mode === 'android' ? {
    build: { outDir: 'dist-android', rollupOptions: { input: 'android.html' } },
    publicDir: false,
  } : {}),
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Run the dev service on 4320 with --dev-origin http://127.0.0.1:5173;
    // 4318 belongs to the installed app. changeOrigin rewrites Host to the
    // service's own, which its host check requires.
    proxy: { '/api': { target: 'http://127.0.0.1:4320', changeOrigin: true, ws: true } },
  },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
}));

const cachePrefix = 'tessera-demo-';

function workerSource(files: string[], version: string): string {
  return `const CACHE_PREFIX = ${JSON.stringify(cachePrefix)};
const CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(version)};
const PRECACHE = ${JSON.stringify(files, null, 2)};
const PRECACHED_PATHS = Object.fromEntries(PRECACHE.map(path => [path, true]));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE.map(path => new Request(path, { cache: 'reload' })));
    } catch (reason) {
      await caches.delete(CACHE_NAME);
      throw reason;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function navigate(request) {
  try {
    const response = await fetch(request);
    if (response.ok) return response;
  } catch {}
  const cache = await caches.open(CACHE_NAME);
  return await cache.match('/demo.html') || Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
  } else if (PRECACHED_PATHS[url.pathname]) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(url.pathname) || fetch(request);
    })());
  }
});
`;
}

/** The browser build owns a separate cache from the native app's offline worker. */
function demoOffline(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'tessera-demo-offline',
    apply: 'build',
    enforce: 'post',
    configResolved(resolved) { config = resolved; },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const files = new Map<string, string | Uint8Array>();
        for (const [name, output] of Object.entries(bundle)) {
          files.set(`/${name}`, output.type === 'chunk' ? output.code : output.source);
        }
        if (config.publicDir) {
          const entries = await readdir(config.publicDir, { recursive: true, withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isFile()) continue;
            const path = join(entry.parentPath, entry.name);
            const name = relative(config.publicDir, path).split(sep).join('/');
            files.set(`/${name}`, await readFile(path));
          }
        }
        if (!files.has('/demo.html')) this.error('The demo offline cache requires demo.html.');
        const paths = [...files.keys()].sort();
        const hash = createHash('sha256').update(workerSource(paths, ''));
        for (const path of paths) {
          const content = files.get(path)!;
          const length = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
          hash.update(`${path}\0${length}\0`).update(content);
        }
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: workerSource(paths, hash.digest('hex').slice(0, 20)) });
      },
    },
  };
}
