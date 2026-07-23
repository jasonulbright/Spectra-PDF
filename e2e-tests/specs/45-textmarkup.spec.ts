import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  getFirstAnnotation,
  removeAnnotation,
  commitPendingEdits,
  saveActiveAs,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// A native /Highlight with QuadPoints, authored raw (as a foreign tool would).
async function makeHighlightedPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const ctx = doc.context;
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [50, 320, 150, 350],
    QuadPoints: [50, 350, 150, 350, 50, 320, 150, 320],
    C: [1, 0.9, 0.3],
    F: 4,
  });
  annot.set(PDFName.of('Contents'), PDFHexString.fromText('inline markup'));
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
  writeFileSync(path, await doc.save());
}

async function highlightCount(path: string): Promise<number> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false }).promise;
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string }[];
  await pdf.loadingTask.destroy();
  return annots.filter((a) => a.subtype === 'Highlight').length;
}

describe('native text markup imported inline (N1)', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-n1-'));
    source = resolve(tmp, 'highlighted.pdf');
    await makeHighlightedPdf(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('imports a native /Highlight as an editable textmarkup annotation', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('canvas');
    const first = await getFirstAnnotation(15_000);
    expect(first).not.toBeNull();
    expect(first!.kind).toBe('textmarkup'); // NOT a Square-highlight
    expect(first!.note).toBe('inline markup');
  });

  it('imports a native /Text sticky note as an editable note annotation', async () => {
    const notePath = resolve(tmp, 'note.pdf');
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const annot = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [40, 300, 58, 318], Name: 'Note', C: [1, 0.85, 0.2] });
    annot.set(PDFName.of('Contents'), PDFHexString.fromText('a sticky comment'));
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
    writeFileSync(notePath, await doc.save());

    await openByPaths([notePath]);
    await setView('canvas');
    const first = await getFirstAnnotation(15_000);
    expect(first).not.toBeNull();
    expect(first!.kind).toBe('note');
    expect(first!.note).toBe('a sticky comment');
  });

  it('deleting it inline and committing removes the original (no duplicate)', async () => {
    await openByPaths([source]);
    await setView('canvas');
    const first = await getFirstAnnotation(15_000);
    expect(first).not.toBeNull();
    await removeAnnotation(first!.docId, first!.pageId, first!.annotationId);
    await commitPendingEdits();
    const dest = resolve(tmp, 'stripped.pdf');
    await saveActiveAs(dest);
    expect(await highlightCount(dest)).toBe(0); // native highlight stripped
  });
});
