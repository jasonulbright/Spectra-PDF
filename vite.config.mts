import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  // Static assets live at the REPO root's public/ (currently the staged OCR
  // runtime from scripts/sync-ocr-assets.mjs) — vite's default would be
  // src/renderer/public, which doesn't exist.
  publicDir: '../../public',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  // Every worker is created with `type: 'module'`, so the bundle can be one
  // too. The default (an IIFE) cannot be code-split, so a worker that reaches
  // `i18n` inlined all 28 locale catalogs — 16 MB parsed on every boot of
  // the metadata worker — where the module format leaves them as the lazy
  // chunks they are in the main bundle.
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
