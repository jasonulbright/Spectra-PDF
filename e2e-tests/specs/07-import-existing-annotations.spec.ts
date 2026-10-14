import { resolve } from 'node:path';
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect } from '@wdio/globals';
import { PDFDict, PDFDocument, PDFName, PDFHexString, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
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
  addAnnotation,
  getPageAnnotations,
  removeAnnotation,
  commitPendingEdits,
  getState,
  invokeAppCommand,
  closeAllFiles,
  scrollIntoReach,
} from '../support/harness.js';
import type { PageAnnotationSnapshot } from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(path: string) {
  return pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) })
    .promise;
}

// A PDF with a /Square annotation authored directly via raw pdf-lib context
// calls rather than Spectra PDF's builder, simulating a foreign annotation.
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

  it('untouched annotations survive a commit unchanged', async () => {
    const source = resolve(tmp, 'reviewed-a.pdf');
    writeFileSync(source, await makeReviewedPdf());

    await openByPaths([source]);
    await setView('canvas');
    const found = await getFirstAnnotation();
    expect(found).not.toBeNull();
    const imported = await getPageAnnotations(found!.docId, found!.pageId);
    expect(imported.map((a) => a.kind).sort()).toEqual(['freetext', 'note', 'note']);

    // A new annotation makes the commit write the page.
    await addAnnotation({ kind: 'highlight', x: 0.6, y: 0.7, w: 0.2, h: 0.05, color: '#ffd54a' });
    await commitPendingEdits();
    const dest = resolve(tmp, 'reviewed-untouched.pdf');
    await saveActiveAs(dest);

    const before = await reviewedEntries(readFileSync(source));
    const after = await reviewedEntries(readFileSync(dest));
    expect(Object.keys(after).sort()).toEqual(['note-1', 'note-2', 'text-1']);
    expect(after).toEqual(before);
    const saved = await PDFDocument.load(readFileSync(dest), { updateMetadata: false });
    expect(saved.getPage(0).node.Annots()!.size()).toBe(4);
  });

  it('an edited note keeps its author', async () => {
    const source = resolve(tmp, 'reviewed-b.pdf');
    writeFileSync(source, await makeReviewedPdf());

    await openByPaths([source]);
    await setView('canvas');
    const found = await getFirstAnnotation();
    expect(found).not.toBeNull();
    const imported = await getPageAnnotations(found!.docId, found!.pageId);
    const first = imported.find((a) => a.note === 'First note');
    expect(first).toBeDefined();
    await recolorAnnotation(found!.docId, found!.pageId, first!.id, '#2f6fed');
    await commitPendingEdits();
    const dest = resolve(tmp, 'reviewed-edited.pdf');
    await saveActiveAs(dest);

    const before = await reviewedEntries(readFileSync(source));
    const after = await reviewedEntries(readFileSync(dest));
    expect(after['note-2']).toEqual(before['note-2']);
    expect(after['text-1']).toEqual(before['text-1']);
    expect(after['note-1']).toMatchObject({
      T: '(A. Reviewer)', NM: '(note-1)', CreationDate: before['note-1'].CreationDate,
      Subj: '(Review)', Contents: '(First note)', Name: '/Comment',
    });
    expect((after['note-1'].C.match(/[\d.]+/g) ?? []).map((v) => Math.round(Number(v) * 255))).toEqual([47, 111, 237]); // #2f6fed
    expect(after['note-1'].M).not.toBe(before['note-1'].M);
  });
});

// A file as a reviewer's tool writes it: two notes with an author, a subject,
// both dates and a name, and a free text in ten point Times.
async function makeReviewedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const times = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', Encoding: 'WinAnsiEncoding' }));
  const date = "D:20240102030405+01'00'";
  const entries = [
    { name: 'note-1', extra: { Subtype: 'Text', Rect: [50, 700, 70, 720], Name: 'Comment', F: 28, C: [1, 0.8, 0] }, contents: 'First note' },
    { name: 'note-2', extra: { Subtype: 'Text', Rect: [100, 700, 120, 720], Name: 'Key', F: 28, C: [0, 0.5, 1] }, contents: 'Second note' },
    {
      name: 'text-1', contents: 'Ten point text',
      extra: {
        Subtype: 'FreeText', Rect: [50, 600, 250, 640], F: 4, Q: 1, BS: { W: 2 },
        AP: { N: ctx.register(ctx.stream('BT /TiRo 10 Tf 0 0 1 rg 60 16 Td (Ten point text) Tj ET', {
          Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 40], Resources: { Font: { TiRo: times } },
        })) },
      },
    },
  ].map(({ name, extra, contents }) => {
    const annot = ctx.obj({ Type: 'Annot', P: page.ref, ...extra });
    for (const [key, value] of Object.entries({ NM: name, T: 'A. Reviewer', M: date, CreationDate: date, Subj: 'Review', Contents: contents })) {
      annot.set(PDFName.of(key), PDFString.of(value));
    }
    if (name === 'text-1') annot.set(PDFName.of('DA'), PDFString.of('0 0 1 rg /TiRo 10 Tf'));
    return ctx.register(annot);
  });
  page.node.set(PDFName.of('Annots'), ctx.obj(entries));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.register(ctx.obj({ Fields: [], DR: { Font: { TiRo: times } } })));
  return doc.save({ useObjectStreams: false });
}

/** Each named annotation of page 1 as text: every entry but the page
 *  reference, and the content of its normal appearance stream. */
async function reviewedEntries(bytes: Uint8Array): Promise<Record<string, Record<string, string>>> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: Record<string, Record<string, string>> = {};
  for (const ref of doc.getPage(0).node.Annots()?.asArray() ?? []) {
    const dict = doc.context.lookup(ref, PDFDict);
    const name = dict.lookup(PDFName.of('NM'));
    if (!(name instanceof PDFString || name instanceof PDFHexString)) continue;
    const entry: Record<string, string> = {};
    for (const [key, value] of dict.entries()) {
      const label = key.decodeText();
      if (label === 'P') continue;
      if (label !== 'AP') {
        entry[label] = String(value);
        continue;
      }
      const normal = doc.context.lookup(value, PDFDict).lookup(PDFName.of('N'));
      entry.AP = normal instanceof PDFRawStream
        ? Buffer.from(decodePDFRawStream(normal).decode()).toString('latin1') : String(normal);
    }
    out[name.decodeText()] = entry;
  }
  return out;
}

// A free text as another program writes it: a magenta box with a line of
// Times, an author and a name.
const FOREIGN_FILL = [255, 0, 255];

async function makeForeignFreeTextPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const times = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', Encoding: 'WinAnsiEncoding' }));
  const appearance = ctx.register(ctx.stream('1 0 1 rg 0 0 240 80 re f BT /TiRo 10 Tf 0 g 90 36 Td (Foreign text) Tj ET', {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 240, 80], Resources: { Font: { TiRo: times } },
  }));
  const text = ctx.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [60, 620, 300, 700], F: 4, C: [1, 0, 1], AP: { N: appearance }, Q: 1 });
  text.set(PDFName.of('DA'), PDFString.of('0 g /TiRo 10 Tf'));
  text.set(PDFName.of('Contents'), PDFString.of('Foreign text'));
  text.set(PDFName.of('NM'), PDFString.of('text-1'));
  text.set(PDFName.of('T'), PDFString.of('A. Reviewer'));
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(text)]));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.register(ctx.obj({ Fields: [], DR: { Font: { TiRo: times } } })));
  return doc.save({ useObjectStreams: false });
}

interface OverlayBody {
  rect: { x: number; y: number; w: number; h: number };
  /** The overlay draws its own text box body. */
  text: boolean;
  /** One RGBA sample of the kept-appearance preview for each point asked for. */
  preview: { drawn: boolean; width: number; height: number; samples: number[][] } | null;
}

/** What the overlay draws for one annotation. `points` are fractions of the
 * preview's width and height. */
async function overlayBodyOf(annotationId: string, points: number[][] = [[0.08, 0.15], [0.92, 0.85]]): Promise<OverlayBody | null> {
  return (await browser.execute(function (id: string, fractions: number[][]) {
    const el = Array.from(document.querySelectorAll('[data-annot-id]')).find(
      (e) => e.getAttribute('data-annot-id') === id,
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const canvas = el.querySelector('canvas[data-testid="kept-appearance-preview"]') as HTMLCanvasElement | null;
    const context = canvas ? canvas.getContext('2d') : null;
    return {
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      text: el.querySelector('.page-annot-text-body') !== null,
      preview: canvas
        ? {
            drawn: canvas.dataset.drawn === 'true',
            width: canvas.width,
            height: canvas.height,
            samples: fractions.map(function (point) {
              return context
                ? Array.from(context.getImageData(Math.floor(canvas.width * point[0]), Math.floor(canvas.height * point[1]), 1, 1).data)
                : [];
            }),
          }
        : null,
    };
  }, annotationId, points)) as OverlayBody | null;
}

/** One RGBA sample of the page raster for each point, given as fractions of
 * the annotation's box on the screen. Null until the base raster is painted. */
async function pageRasterAt(annotationId: string, points: number[][]): Promise<number[][] | null> {
  return (await browser.execute(function (id: string, fractions: number[][]) {
    const el = Array.from(document.querySelectorAll('[data-annot-id]')).find(
      (e) => e.getAttribute('data-annot-id') === id,
    );
    const cell = el ? el.closest('[data-page-id]') : null;
    if (!el || !cell) return null;
    const base = cell.querySelector('canvas.pageview-base.ready') as HTMLCanvasElement | null;
    const detail = cell.querySelector('canvas.pageview-detail') as HTMLCanvasElement | null;
    if (!base) return null;
    const box = el.getBoundingClientRect();
    const sample = function (canvas: HTMLCanvasElement, x: number, y: number): number[] | null {
      const r = canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || x < r.left || x >= r.right || y < r.top || y >= r.bottom) return null;
      const context = canvas.getContext('2d');
      if (!context) return null;
      const px = Math.min(canvas.width - 1, Math.floor(((x - r.left) / r.width) * canvas.width));
      const py = Math.min(canvas.height - 1, Math.floor(((y - r.top) / r.height) * canvas.height));
      return Array.from(context.getImageData(px, py, 1, 1).data);
    };
    return fractions.map(function (point) {
      const x = box.left + point[0] * box.width;
      const y = box.top + point[1] * box.height;
      const sharp = detail && detail.style.display !== 'none' ? sample(detail, x, y) : null;
      return sharp || sample(base, x, y) || [];
    });
  }, annotationId, points)) as number[][] | null;
}

const isColour = (sample: number[] | undefined, rgb: number[]): boolean =>
  !!sample && sample.length >= 4 && sample[3] > 200 && rgb.every((value, i) => Math.abs(sample[i] - value) <= 24);

/** The active document's first page and its free text, as the state holds
 * them now. Page and annotation ids change at every read-back. */
async function firstPageFreeText(): Promise<{ docId: string; pageId: string; text: PageAnnotationSnapshot } | null> {
  const first = await browser.executeAsync<{ docId: string; pageId: string } | null, []>(function (done) {
    (window as any).__SPECTRA_TEST__
      .getFirstAnnotation(2000)
      .then((x: unknown) => done(x as any))
      .catch(() => done(null as any));
  });
  if (!first) return null;
  const text = (await getPageAnnotations(first.docId, first.pageId)).find((a) => a.kind === 'freetext');
  return text ? { docId: first.docId, pageId: first.pageId, text } : null;
}

describe('a moved free text of another producer', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-kept-'));
    const path = resolve(tmp, 'foreign-text.pdf');
    writeFileSync(path, await makeForeignFreeTextPdf());
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([path]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: `opening ${path} did not land on canvas`,
    });
    await invokeAppCommand('view.documentView');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(async () => (await firstPageFreeText())?.text.originalAppearance === true, {
      timeout: 20_000,
      timeoutMsg: 'the free text of the file was never read as an import with an appearance',
    });
    await invokeAppCommand('tools.select');
  });

  after(async () => {
    await invokeAppCommand('tools.select');
    await invokeAppCommand('tools.close');
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('shows its own appearance at the new place before the commit, and the commit keeps it', async () => {
    const before = (await firstPageFreeText())!;
    await browser.waitUntil(async () => (await overlayBodyOf(before.text.id)) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the imported free text has no body on the canvas',
    });
    // Unedited, the page raster shows the free text and the overlay draws nothing.
    const untouched = (await overlayBodyOf(before.text.id))!;
    expect({ text: untouched.text, preview: untouched.preview }).toEqual({ text: false, preview: null });
    await browser.waitUntil(
      async () => {
        const samples = await pageRasterAt(before.text.id, [[0.08, 0.15], [0.92, 0.85]]);
        return !!samples && samples.every((sample) => isColour(sample, FOREIGN_FILL));
      },
      { timeout: 15_000, timeoutMsg: 'the page raster never showed the free text' },
    );

    // Drag the body down by more than its own height.
    const centre = await scrollIntoReach(`[data-annot-id="${before.text.id}"]`);
    const win = (await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }))) as { w: number; h: number };
    const clamp = (value: number, limit: number): number => Math.round(Math.max(10, Math.min(value, limit - 10)));
    const from = (await overlayBodyOf(before.text.id))!;
    const toX = clamp(centre.x + from.rect.w * 0.2, win.w);
    const toY = clamp(centre.y + from.rect.h * 1.6, win.h);
    try {
      await browser
        .action('pointer', { parameters: { pointerType: 'mouse' } })
        .move({ x: centre.x, y: centre.y })
        .down()
        .pause(60)
        .move({ x: centre.x + Math.sign(toX - centre.x) * 8, y: centre.y + Math.sign(toY - centre.y) * 8 })
        .pause(60)
        .move({ x: toX, y: toY })
        .pause(90)
        .up()
        .perform();
    } finally {
      await browser.releaseActions();
    }
    await browser.waitUntil(
      async () => {
        const now = (await firstPageFreeText())?.text;
        return now !== undefined && (Math.abs(now.x - before.text.x) > 0.01 || Math.abs(now.y - before.text.y) > 0.01);
      },
      { timeout: 5_000, timeoutMsg: 'the drag did not move the free text' },
    );
    const moved = (await firstPageFreeText())!;
    expect(moved.text.id).toBe(before.text.id);
    expect([moved.text.w, moved.text.h]).toEqual([before.text.w, before.text.h]);

    // Before any commit the body is the free text's own appearance: its
    // pixels at the new place, and no text box body of the overlay.
    await browser.waitUntil(async () => (await overlayBodyOf(moved.text.id))?.preview?.drawn === true, {
      timeout: 15_000,
      timeoutMsg: 'the moved free text never drew its appearance',
    });
    const shown = (await overlayBodyOf(moved.text.id))!;
    expect(shown.text).toBe(false);
    expect(shown.preview!.width).toBeGreaterThan(8);
    expect(shown.preview!.height).toBeGreaterThan(8);
    for (const sample of shown.preview!.samples) expect(isColour(sample, FOREIGN_FILL)).toBe(true);
    expect(shown.rect.y - from.rect.y).toBeGreaterThan((toY - centre.y) / 2);

    // The commit writes the original at the new rectangle. After the
    // read-back the overlay draws nothing again and the page raster shows the
    // free text there.
    await commitPendingEdits();
    await browser.waitUntil(
      async () => {
        const now = await firstPageFreeText();
        if (!now || now.text.id === moved.text.id) return false;
        const body = await overlayBodyOf(now.text.id);
        if (!body || body.preview !== null || body.text) return false;
        const samples = await pageRasterAt(now.text.id, [[0.08, 0.15], [0.92, 0.85]]);
        return !!samples && samples.every((sample) => isColour(sample, FOREIGN_FILL));
      },
      { timeout: 30_000, timeoutMsg: 'the page raster never showed the free text at its new place' },
    );
    const read = (await firstPageFreeText())!;
    expect(Math.abs(read.text.y - moved.text.y)).toBeLessThan(0.002);
    expect(Math.abs(read.text.x - moved.text.x)).toBeLessThan(0.002);

    const dest = resolve(tmp, 'foreign-text-moved.pdf');
    await saveActiveAs(dest);
    const source = await PDFDocument.load(readFileSync(resolve(tmp, 'foreign-text.pdf')), { updateMetadata: false });
    const saved = await PDFDocument.load(readFileSync(dest), { updateMetadata: false });
    const only = (doc: PDFDocument): PDFDict => doc.context.lookup(doc.getPage(0).node.Annots()!.get(0), PDFDict);
    const stream = (dict: PDFDict): string => {
      const normal = dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
      const bytes = normal instanceof PDFRawStream ? decodePDFRawStream(normal).decode() : (normal as unknown as { getContents(): Uint8Array }).getContents();
      return Buffer.from(bytes).toString('latin1');
    };
    expect(saved.getPage(0).node.Annots()!.size()).toBe(1);
    expect(stream(only(saved))).toBe(stream(only(source)));
    expect(String(only(saved).lookup(PDFName.of('DA')))).toBe('(0 g /TiRo 10 Tf)');
    expect(String(only(saved).lookup(PDFName.of('T')))).toBe('(A. Reviewer)');
    const rect = (dict: PDFDict): number[] => (dict.lookup(PDFName.of('Rect')) as unknown as { asArray(): { asNumber(): number }[] }).asArray().map((v) => v.asNumber());
    const [x0, y0, x1, y1] = rect(only(saved));
    expect(x1 - x0).toBeCloseTo(240, 3);
    expect(y1 - y0).toBeCloseTo(80, 3);
    // Dragged down: the rectangle is lower on the page.
    expect(y1).toBeLessThan(700 - 40);
  });
});
