import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: { host: '127.0.0.1' },
});
