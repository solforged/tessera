import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig(({ mode }) => ({
  plugins: [solid()],
  define: { __TESSERA_DEMO__: mode === 'demo', __TESSERA_ANDROID__: mode === 'android' },
  ...(mode === 'demo' ? {
    build: { outDir: 'dist-demo', rollupOptions: { input: 'demo.html' } },
    publicDir: false,
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
