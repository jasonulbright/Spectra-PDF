import { resolve } from 'node:path';
import { readFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  saveActiveAs,
  addAnnotation,
  recolorAnnotation,
  commitPendingEdits,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// pdfjs-dist reads bytes off disk here in the Node/mocha process (not through
// the harness) — it's the same non-circular verification style as the unit
// tests in tests/workspace-commit.test.ts, just proving the annotation
// survives the real Tauri IPC + commit-bridge round trip end to end.
async function loadPdf(path: string) {
  return pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false })
    .promise;
}

describe('annotations survive the commit round trip', () => {
  let tmp: string;
  let dest: string;
  // Two distinct SOURCE paths, not just two destinations: OPEN_FILE resets
  // state.files for a path but does NOT clear state.workspace.documents for
  // it (that's the async indexer's job, via SET_WORKSPACE_DOCUMENTS) — so
  // reopening the SAME path mid-session can briefly serve the stale,
  // already-annotated workspace document instead of a fresh one from disk.
  // Real gap, but out of scope for this slice; sidestepped here by giving
  // each test its own source file so there's nothing stale to reuse.
  let samplePdfA: string;
  let samplePdfB: string;
  let samplePdfC: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-annot-'));
    dest = resolve(tmp, 'annotated.pdf');
    samplePdfA = resolve(tmp, 'sample-a.pdf');
    samplePdfB = resolve(tmp, 'sample-b.pdf');
    samplePdfC = resolve(tmp, 'sample-c.pdf');
    copyFileSync(SAMPLE_PDF, samplePdfA);
    copyFileSync(SAMPLE_PDF, samplePdfB);
    copyFileSync(SAMPLE_PDF, samplePdfC);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('a highlight added via the reducer path bakes into the saved file as /Square', async () => {
    await waitForHarness();
    await openByPaths([samplePdfA]);
    await setView('canvas');

    const { docId, pageId } = await addAnnotation({
      kind: 'highlight',
      x: 0.1,
      y: 0.15,
      w: 0.3,
      h: 0.1,
      color: '#ffd54a',
      note: 'e2e highlight',
    });
    expect(docId).toBeTruthy();
    expect(pageId).toBeTruthy();

    await commitPendingEdits();
    await saveActiveAs(dest);
    expect(existsSync(dest)).toBe(true);

    const pdf = await loadPdf(dest);
    const page = await pdf.getPage(1);
    const annots = (await page.getAnnotations()) as {
      subtype: string;
      contentsObj?: { str: string };
    }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].subtype).toBe('Square');
    expect(annots[0].contentsObj?.str).toBe('e2e highlight');
    await pdf.loadingTask.destroy();
  });

  it('a stamp added via the reducer path bakes into the saved file as /Stamp', async () => {
    const stampDest = resolve(tmp, 'stamped.pdf');
    await openByPaths([samplePdfB]);
    await setView('canvas');

    await addAnnotation({
      kind: 'stamp',
      x: 0.3,
      y: 0.4,
      w: 0.32,
      h: 0.09,
      color: '#2fbf71',
      note: 'APPROVED',
    });
    await commitPendingEdits();
    await saveActiveAs(stampDest);

    const pdf = await loadPdf(stampDest);
    const page = await pdf.getPage(1);
    const annots = (await page.getAnnotations()) as {
      subtype: string;
      contentsObj?: { str: string };
    }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].subtype).toBe('Stamp');
    expect(annots[0].contentsObj?.str).toBe('APPROVED');
    await pdf.loadingTask.destroy();
  });

  it('a recolored annotation bakes with its NEW color, not the one it was created with', async () => {
    const recolorDest = resolve(tmp, 'recolored.pdf');
    await openByPaths([samplePdfC]);
    await setView('canvas');

    const { docId, pageId, annotationId } = await addAnnotation({
      kind: 'highlight',
      x: 0.1,
      y: 0.15,
      w: 0.3,
      h: 0.1,
      color: '#ffd54a', // yellow at creation
      note: 'recolor me',
    });
    await recolorAnnotation(docId, pageId, annotationId, '#2f6fed'); // blue
    await commitPendingEdits();
    await saveActiveAs(recolorDest);

    const pdf = await loadPdf(recolorDest);
    const page = await pdf.getPage(1);
    const annots = (await page.getAnnotations()) as { subtype: string; color: number[] }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].subtype).toBe('Square');
    // pdf.js reports annotation color as a typed array of 0..255 RGB;
    // #2f6fed = (47, 111, 237). Array.from avoids a typed-array-vs-plain-array
    // toEqual mismatch.
    expect(Array.from(annots[0].color)).toEqual([47, 111, 237]);
    await pdf.loadingTask.destroy();
  });
});
