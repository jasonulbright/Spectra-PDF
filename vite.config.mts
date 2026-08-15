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
  server: {
    port: 5173,
    strictPort: true,
  },
});
