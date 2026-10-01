import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Run the service with --dev-origin http://127.0.0.1:5173.
    proxy: { '/api': { target: 'http://127.0.0.1:4318' } },
  },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
});
