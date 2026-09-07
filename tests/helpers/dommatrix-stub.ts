// pdf.js's main entry point references `DOMMatrix` at module-evaluation time
// (a class extends it), which does not exist in vitest's default `node`
// environment. This project runs no DOM test environment (see CLAUDE.md), so
// rather than adding one for a single import, the smallest possible stub is
// installed before `pdfjs-dist` is ever imported. This file must be the
// FIRST import in any test that imports `../src/renderer/lib/doc-health-pdfjs`
// (or anything importing `pdfjs-dist`) — ESM evaluates imports in source
// order, so a later import of pdfjs-dist sees the stub already in place.
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrixStub {};
}
