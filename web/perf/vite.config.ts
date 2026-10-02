import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: { host: '127.0.0.1', port: 4341, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4340', ws: true, changeOrigin: true } } },
  build: { outDir: 'perf/dist', emptyOutDir: true, rollupOptions: { input: resolve(import.meta.dirname, 'index.html') } },
});
