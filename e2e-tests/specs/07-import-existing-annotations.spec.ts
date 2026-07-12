import { resolve } from 'node:path';
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  saveActiveAs,
  getFirstAnnotation,
  recolorAnnotation,
  removeAnnotation,
  commitPendingEdits,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(path: string) {
  return pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false })
    .promise;
}

// A PDF with a /Square annotation authored directly via raw pdf-lib context
// calls — NOT through Open PDF Studio's own builder — to simulate a file that
// arrived with an annotation some other tool created (Acrobat, etc.).
async function makeForeignAnnotatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const ctx = doc.context;
  const ap = ctx.register(
    ctx.stream('0.9 0.2 0.2 rg 0 0 100 50 re f', {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, 100, 50],
    }),
  );
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Square',
    Rect: [50, 300, 150, 350],
    C: [0.9, 0.2, 0.2],
    F: 4,
    AP: { N: ap },
  });
  annot.set(PDFName.of('Contents'), PDFHexString.fromText('a foreign note'));
  const ref = ctx.register(annot);
  page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  return doc.save();
}

describe('importing pre-existing annotations', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-import-'));
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('a foreign /Square is imported as an editable highlight and does not duplicate on an untouched commit', async () => {
    const source = resolve(tmp, 'foreign-a.pdf');
    writeFileSync(source, await makeForeignAnnotatedPdf());

    await waitForHarness();
    await openByPaths([source]);
    await setView('canvas');

    const found = await getFirstAnnotation();
    expect(found).not.toBeNull();
    expect(found!.kind).toBe('highlight');
    expect(found!.note).toBe('a foreign note');

    // Nothing was edited — commitPendingEdits should be a no-op (nothing
    // dirty), and the ORIGINAL file bytes are what get saved.
    await commitPendingEdits();
    const dest = resolve(tmp, 'untouched.pdf');
    await saveActiveAs(dest);

    const pdf = await loadPdf(dest);
    const annots = (await (await pdf.getPage(1)).getAnnotations()) as {
      subtype: string;
      contentsObj?: { str: string };
    }[];
    expect(annots).toHaveLength(1); // imported, but never duplicated
    expect(annots[0].subtype).toBe('Square');
    expect(annots[0].contentsObj?.str).toBe('a foreign note');
    await pdf.loadingTask.destroy();
  });

  it('recoloring an imported annotation commits the edit without duplicating the original', async () => {
    const source = resolve(tmp, 'foreign-b.pdf');
    writeFileSync(source, await makeForeignAnnotatedPdf());

    await openByPaths([source]);
    await setView('canvas');

    const found = await getFirstAnnotation();
    expect(found).not.toBeNull();
    await recolorAnnotation(found!.docId, found!.pageId, found!.annotationId, '#2f6fed');
    await commitPendingEdits();

    const dest = resolve(tmp, 'recolored-import.pdf');
    await saveActiveAs(dest);

    const pdf = await loadPdf(dest);
    const annots = (await (await pdf.getPage(1)).getAnnotations()) as {
      subtype: string;
      contentsObj?: { str: string };
      color: number[];
    }[];
    expect(annots).toHaveLength(1); // still just one — no duplicate from the strip-and-reauthor path
    expect(annots[0].contentsObj?.str).toBe('a foreign note'); // untouched field survives
    expect(Array.from(annots[0].color)).toEqual([47, 111, 237]); // #2f6fed
    await pdf.loadingTask.destroy();
  });

  it('deleting an imported annotation actually removes it from the saved file', async () => {
    // Regression: without a tombstone for the removed annotation's
    // importedOriginal fingerprint, the commit-time strip has nothing left
    // to match the real object against and the "deleted" annotation
    // silently reappears in the saved file.
    const source = resolve(tmp, 'foreign-c.pdf');
    writeFileSync(source, await makeForeignAnnotatedPdf());

    await openByPaths([source]);
    await setView('canvas');

    const found = await getFirstAnnotation();
    expect(found).not.toBeNull();
    await removeAnnotation(found!.docId, found!.pageId, found!.annotationId);
    await commitPendingEdits();

    const dest = resolve(tmp, 'deleted-import.pdf');
    await saveActiveAs(dest);

    const pdf = await loadPdf(dest);
    const annots = await (await pdf.getPage(1)).getAnnotations();
    expect(annots).toHaveLength(0); // actually gone
    await pdf.loadingTask.destroy();
  });
});
