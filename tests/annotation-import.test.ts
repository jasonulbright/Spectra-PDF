import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFHexString, PDFRawStream, PDFString, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { importPageAnnotations } from '../src/renderer/lib/annotation-import';
import { readRawAnnotationStyles } from '../src/renderer/lib/annotation-raw-style';
import { planCommit, buildCommitBytes } from '../src/renderer/lib/workspace-commit';
import { buildPdf } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import type { OpenDocument, OpenFile, PageRef, Workspace } from '../src/renderer/state/types';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return (await pdfjs.getDocument({ data: bytes.slice() })
    .promise) as PDFDocumentProxy;
}

// Builds a source PDF with a /Square annotation authored directly via raw
// pdf-lib context calls rather than our own addAnnotations, simulating a
// foreign annotation rather
// than round-tripping something Spectra itself wrote.
async function makeForeignAnnotatedPdf(rotation: 0 | 90 | 180 | 270 = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  if (rotation) page.setRotation(degrees(rotation));
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

function makeFile(path: string, buffer: Uint8Array): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name: path,
    pageCount: 1,
    buffer,
    dirty: false,
    undoStack: [],
    redoStack: [],
  };
}

function pageRef(path: string): PageRef {
  return { id: `${path}#p0`, sourceDocId: path, sourcePageIndex: 0, rotation: 0, width: 0, height: 0 };
}

function makeDoc(id: string, file: OpenFile, pages: PageRef[]): OpenDocument {
  return { ...file, id, name: file.name, pages, pageCount: pages.length };
}

describe('importPageAnnotations', () => {
  it('imports a foreign /Square as an editable highlight with a matching fingerprint', async () => {
    const bytes = await makeForeignAnnotatedPdf();
    const pdf = await loadPdf(bytes);
    const page: PDFPageProxy = await pdf.getPage(1);
    const imported = await importPageAnnotations(page);
    expect(imported).toHaveLength(1);
    expect(imported[0].kind).toBe('highlight');
    expect(imported[0].note).toBe('a foreign note');
    expect(imported[0].importedOriginal).toMatchObject({
      subtype: 'Square',
      contents: 'a foreign note',
    });
    // The rect at rotation 0 maps directly: x/300, (400-350)/400 from the top.
    expect(imported[0].x).toBeCloseTo(50 / 300, 5);
    expect(imported[0].y).toBeCloseTo((400 - 350) / 400, 5);
    expect(imported[0].w).toBeCloseTo(100 / 300, 5);
    expect(imported[0].h).toBeCloseTo(50 / 400, 5);
    await pdf.loadingTask.destroy();
  });

  it('ignores unrecognized subtypes (e.g. Link) — nothing imported, nothing to strip later', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const link = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50] });
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(link)]));
    const bytes = await doc.save();
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    expect(imported).toEqual([]);
    await pdf.loadingTask.destroy();
  });

  it('A multi-stroke /Ink (a signature) imports WHOLE, one stroke per pen lift', async () => {
    // This exact shape used to be refused outright (the model held one
    // stroke); now every /InkList sub-path arrives as its own stroke.
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const annot = ctx.obj({
      Type: 'Annot',
      Subtype: 'Ink',
      Rect: [30, 200, 210, 300],
      C: [0.2, 0.4, 0.9],
      F: 4,
      InkList: [
        [30, 200, 90, 300],
        [90, 200, 150, 300, 180, 250],
        [180, 200, 210, 200],
      ],
    });
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
    const bytes = await doc.save();
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    expect(imported).toHaveLength(1);
    expect(imported[0].kind).toBe('ink');
    expect(imported[0].strokes).toHaveLength(3);
    expect(imported[0].strokes![1]).toHaveLength(6);
    // First stroke's first point: (30, 200) → display space (y from the top).
    expect(imported[0].strokes![0][0]).toBeCloseTo(30 / 300, 5);
    expect(imported[0].strokes![0][1]).toBeCloseTo((400 - 200) / 400, 5);
    // The bbox spans ALL strokes, not just the first.
    expect(imported[0].x).toBeCloseTo(30 / 300, 5);
    expect(imported[0].w).toBeCloseTo(180 / 300, 5);
    await pdf.loadingTask.destroy();
  });

  it('floors a carried /BS /W 0 rather than re-committing a device hairline', async () => {
    // `/BS /W 0` means NO BORDER for the shapes that have one to omit. An
    // /Ink is nothing but its border, so carrying the 0 through to `0 w`
    // would redraw an existing document's mark at the output device's
    // thinnest line instead of the document's.
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const annot = ctx.obj({
      Type: 'Annot',
      Subtype: 'Ink',
      Rect: [30, 200, 210, 300],
      C: [0.2, 0.4, 0.9],
      F: 4,
      BS: { W: 0 },
      InkList: [[30, 200, 210, 300]],
    });
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
    const bytes = await doc.save();
    const styles = await readRawAnnotationStyles(bytes);
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1), styles![0]);
    expect(imported[0].kind).toBe('ink');
    expect(imported[0].strokeWidth).toBeGreaterThan(0);
    await pdf.loadingTask.destroy();
  });

  it('keeps a carried nib the file actually specifies', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const annot = ctx.obj({
      Type: 'Annot',
      Subtype: 'Ink',
      Rect: [30, 200, 210, 300],
      C: [0.2, 0.4, 0.9],
      F: 4,
      BS: { W: 8 },
      InkList: [[30, 200, 210, 300]],
    });
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
    const bytes = await doc.save();
    const styles = await readRawAnnotationStyles(bytes);
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1), styles![0]);
    expect(imported[0].strokeWidth).toBe(8);
    await pdf.loadingTask.destroy();
  });
});

describe('imported annotation commit round trip', () => {
  it('an unedited imported annotation re-commits as exactly one annotation, not a duplicate', async () => {
    const bytes = await makeForeignAnnotatedPdf();
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    await pdf.loadingTask.destroy();

    const file = makeFile('a.pdf', bytes);
    const files = new Map([['a.pdf', file]]);
    const workspace: Workspace = {
      documents: [makeDoc('a#0', file, [{ ...pageRef('a.pdf'), annotations: imported }])],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const output = await buildCommitBytes(plan);
    const rebuilt = await loadPdf(output);
    const annots = (await (await rebuilt.getPage(1)).getAnnotations()) as {
      subtype: string;
      contentsObj?: { str: string };
    }[];
    expect(annots).toHaveLength(1); // NOT 2 — the original was matched and stripped
    expect(annots[0].subtype).toBe('Square');
    expect(annots[0].contentsObj?.str).toBe('a foreign note');
    await rebuilt.loadingTask.destroy();
  });

  it('an edited imported annotation commits the EDITED values, still without duplicating', async () => {
    const bytes = await makeForeignAnnotatedPdf();
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    await pdf.loadingTask.destroy();

    const edited = { ...imported[0], note: 'edited note', color: '#2f6fed' };
    const file = makeFile('a.pdf', bytes);
    const files = new Map([['a.pdf', file]]);
    const workspace: Workspace = {
      documents: [makeDoc('a#0', file, [{ ...pageRef('a.pdf'), annotations: [edited] }])],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const annots = (await (await rebuilt.getPage(1)).getAnnotations()) as {
      subtype: string;
      contentsObj?: { str: string };
      color: number[];
    }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].contentsObj?.str).toBe('edited note');
    expect(Array.from(annots[0].color)).toEqual([47, 111, 237]);
    await rebuilt.loadingTask.destroy();
  });

  it('imports and re-commits correctly on a page with an inherent /Rotate', async () => {
    const bytes = await makeForeignAnnotatedPdf(90);
    const beforePdf = await loadPdf(bytes);
    const beforePage = await beforePdf.getPage(1);
    const viewportBefore = beforePage.getViewport({ scale: 1 }); // includes the inherent rotation
    const [origAnnot] = (await beforePage.getAnnotations()) as { rect: [number, number, number, number] }[];
    const imported = await importPageAnnotations(beforePage);
    expect(imported).toHaveLength(1);
    await beforePdf.loadingTask.destroy();

    const file = makeFile('a.pdf', bytes);
    const files = new Map([['a.pdf', file]]);
    const workspace: Workspace = {
      documents: [makeDoc('a#0', file, [{ ...pageRef('a.pdf'), annotations: imported }])],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const rebuiltPage = await rebuilt.getPage(1);
    const annots = (await rebuiltPage.getAnnotations()) as { rect: [number, number, number, number] }[];
    expect(annots).toHaveLength(1); // no duplicate on a rotated page either
    // The re-baked annotation must land on the SAME rotated-viewport position
    // as the original /Square did before it was ever imported.
    const viewportAfter = rebuiltPage.getViewport({ scale: 1 });
    const p1 = viewportBefore.convertToViewportPoint(origAnnot.rect[0], origAnnot.rect[1]);
    const p2 = viewportBefore.convertToViewportPoint(origAnnot.rect[2], origAnnot.rect[3]);
    const q1 = viewportAfter.convertToViewportPoint(annots[0].rect[0], annots[0].rect[1]);
    const q2 = viewportAfter.convertToViewportPoint(annots[0].rect[2], annots[0].rect[3]);
    expect(Math.min(q1[0], q2[0])).toBeCloseTo(Math.min(p1[0], p2[0]), 1);
    expect(Math.min(q1[1], q2[1])).toBeCloseTo(Math.min(p1[1], p2[1]), 1);
    expect(Math.abs(q1[0] - q2[0])).toBeCloseTo(Math.abs(p1[0] - p2[0]), 1);
    expect(Math.abs(q1[1] - q2[1])).toBeCloseTo(Math.abs(p1[1] - p2[1]), 1);
    await rebuilt.loadingTask.destroy();
  });

  it('safety: an annotation with NO matching fingerprint is never removed (import-miss simulation)', async () => {
    // Simulates the scenario the design note calls out: a recognized-subtype
    // original that import somehow never picked up. It must be left alone —
    // the ONLY acceptable failure mode is a visible duplicate, never deletion.
    const bytes = await makeForeignAnnotatedPdf();
    const file = makeFile('a.pdf', bytes);
    const files = new Map([['a.pdf', file]]);
    // A brand-new annotation with NO importedOriginal at all — nothing to
    // match against the pre-existing /Square, so it must survive untouched.
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', file, [
          {
            ...pageRef('a.pdf'),
            annotations: [
              { id: 'new1', kind: 'highlight', x: 0.6, y: 0.1, w: 0.2, h: 0.1, color: '#ffd54a', note: 'brand new' },
            ],
          },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const annots = (await (await rebuilt.getPage(1)).getAnnotations()) as { contentsObj?: { str: string } }[];
    // Both the untouched original AND the new one are present.
    expect(annots).toHaveLength(2);
    const notes = annots.map((a) => a.contentsObj?.str).sort();
    expect(notes).toEqual(['a foreign note', 'brand new']);
    await rebuilt.loadingTask.destroy();
  });

  it('deleting an imported annotation actually removes it from the file (not a silent no-op)', async () => {
    // Regression: REMOVE_ANNOTATION drops the PageAnnotation, taking its
    // importedOriginal fingerprint with it — without PageRef.removedImportedOriginals
    // as a tombstone, stripImportedOriginals has nothing left to match the
    // real object against and leaves it in place, undoing the "delete".
    const bytes = await makeForeignAnnotatedPdf();
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    await pdf.loadingTask.destroy();
    expect(imported).toHaveLength(1);

    const file = makeFile('a.pdf', bytes);
    const doc: OpenDocument = makeDoc('a#0', file, [{ ...pageRef('a.pdf'), annotations: imported }]);
    const withImport = {
      ...initialState,
      files: new Map([['a.pdf', file]]),
      workspace: { documents: [doc] },
    };
    const afterRemove = appReducer(withImport, {
      type: 'REMOVE_ANNOTATION',
      docId: 'a#0',
      pageId: 'a.pdf#p0',
      annotationId: imported[0].id,
    });
    const page = afterRemove.workspace.documents[0].pages[0];
    expect(page.annotations).toEqual([]);
    expect(page.removedImportedOriginals).toEqual([imported[0].importedOriginal]);

    const files = new Map([['a.pdf', file]]);
    const [plan] = planCommit(afterRemove.workspace, files, ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const annots = await (await rebuilt.getPage(1)).getAnnotations();
    expect(annots).toHaveLength(0); // actually gone, not reappeared
    await rebuilt.loadingTask.destroy();
  });

  it('INVERSION — a multi-stroke Ink imports whole and round-trips all strokes', async () => {
    // This test used to pin the REFUSAL ("would lose strokes after the
    // first on edit") — the no-degradation rule under a single-stroke
    // model. The model now holds per-stroke paths, so the same rule is
    // satisfied by fidelity: import, commit, and every stroke survives.
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const ink = ctx.obj({
      Type: 'Annot',
      Subtype: 'Ink',
      Rect: [0, 0, 100, 100],
      InkList: [
        [0, 0, 50, 50],
        [10, 10, 60, 60],
      ],
      F: 4,
    });
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ink)]));
    const bytes = await doc.save();
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    expect(imported).toHaveLength(1);
    expect(imported[0].kind).toBe('ink');
    expect(imported[0].strokes).toHaveLength(2);
    await pdf.loadingTask.destroy();

    // Commit the import back out: ONE /Ink, both strokes, no duplicate.
    const file = makeFile('a.pdf', bytes);
    const workspace: Workspace = {
      documents: [
        makeDoc('a.pdf#0', file, [
          { ...pageRef('a.pdf'), annotations: imported },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, new Map([['a.pdf', file]]), ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const rebuiltPage = await rebuilt.getPage(1);
    const annots = (await rebuiltPage.getAnnotations()) as {
      subtype: string;
      inkLists?: Float32Array[];
    }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].subtype).toBe('Ink');
    expect(annots[0].inkLists).toHaveLength(2);
    await rebuilt.loadingTask.destroy();
  });

  it('flags an AP-less annotation as hasAppearance:false so the overlay does not hide it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    // A /Square with no /AP at all — pdf.js's base raster won't synthesize a
    // fallback appearance for every case, so PageCell must not suppress this.
    const annot = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 50, 50], F: 4 });
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
    const bytes = await doc.save();
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    expect(imported).toHaveLength(1);
    expect(imported[0].importedOriginal?.hasAppearance).toBe(false);
    await pdf.loadingTask.destroy();
  });

  it('a committed box highlight is typed /Highlight in the file, and reimports as one', async () => {
    // Regression: the box highlight committed as a /Square, so the round trip
    // through the file retyped it — the comments list read the file's subtype
    // and called a highlight a Square.
    const source = await PDFDocument.create();
    source.addPage([300, 400]);
    const bytes = await source.save();
    const file = makeFile('a.pdf', bytes);
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', file, [
          {
            ...pageRef('a.pdf'),
            annotations: [
              { id: 'h1', kind: 'highlight', x: 0.1, y: 0.1, w: 0.4, h: 0.05, color: '#ffe14a', note: 'marked' },
            ],
          },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, new Map([['a.pdf', file]]), ['a.pdf']);
    const committed = await buildCommitBytes(plan);
    const rebuilt = await loadPdf(committed);
    const annots = (await (await rebuilt.getPage(1)).getAnnotations()) as {
      subtype: string;
      quadPoints?: unknown;
    }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].subtype).toBe('Highlight');
    expect(annots[0].quadPoints).toBeTruthy();
    const reimported = await importPageAnnotations(await rebuilt.getPage(1));
    expect(reimported).toHaveLength(1);
    expect(reimported[0].kind).toBe('textmarkup');
    expect(reimported[0].markupType).toBe('highlight');
    expect(reimported[0].note).toBe('marked');
    await rebuilt.loadingTask.destroy();
  });

  it('a box that ARRIVED as a foreign /Square re-commits as a /Square, never converted', async () => {
    const bytes = await makeForeignAnnotatedPdf();
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    await pdf.loadingTask.destroy();
    expect(imported[0].kind).toBe('highlight');
    const file = makeFile('a.pdf', bytes);
    const workspace: Workspace = {
      documents: [makeDoc('a#0', file, [{ ...pageRef('a.pdf'), annotations: imported }])],
    };
    const [plan] = planCommit(workspace, new Map([['a.pdf', file]]), ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const annots = (await (await rebuilt.getPage(1)).getAnnotations()) as { subtype: string }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].subtype).toBe('Square');
    await rebuilt.loadingTask.destroy();
  });

  it('imports and re-commits correctly on a page with a CropBox distinct from its MediaBox', async () => {
    // Import reads pdf.js's page.view (crop-intersected); the builder must
    // map against the SAME box (copied.getCropBox(), not getMediaBox()) or
    // an edited-then-recommitted imported annotation drifts by the crop
    // offset. This fixture's CropBox is inset and origin-shifted from its
    // MediaBox, which would expose that drift if the boxes ever diverge again.
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 500]);
    page.setCropBox(50, 50, 300, 400); // inset on all sides, origin shifted
    const ctx = doc.context;
    const ap = ctx.register(
      ctx.stream('0.2 0.2 0.9 rg 0 0 60 40 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: [0, 0, 60, 40],
      }),
    );
    const annot = ctx.obj({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [100, 200, 160, 240], // within the crop box
      C: [0.2, 0.2, 0.9],
      F: 4,
      AP: { N: ap },
    });
    annot.set(PDFName.of('Contents'), PDFHexString.fromText('cropped note'));
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
    const bytes = await doc.save();

    const beforePdf = await loadPdf(bytes);
    const beforePage = await beforePdf.getPage(1);
    const viewportBefore = beforePage.getViewport({ scale: 1 });
    const [origAnnot] = (await beforePage.getAnnotations()) as { rect: [number, number, number, number] }[];
    const imported = await importPageAnnotations(beforePage);
    expect(imported).toHaveLength(1);
    await beforePdf.loadingTask.destroy();

    // Recolor (edit) so the annotation is re-authored, not left pristine —
    // this is exactly the path that exposed the CropBox/MediaBox mismatch.
    const edited = { ...imported[0], color: '#2f6fed' };
    const file = makeFile('a.pdf', bytes);
    const files = new Map([['a.pdf', file]]);
    const workspace: Workspace = {
      documents: [makeDoc('a#0', file, [{ ...pageRef('a.pdf'), annotations: [edited] }])],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const rebuiltPage = await rebuilt.getPage(1);
    const annots = (await rebuiltPage.getAnnotations()) as { rect: [number, number, number, number] }[];
    expect(annots).toHaveLength(1);
    const viewportAfter = rebuiltPage.getViewport({ scale: 1 });
    const p1 = viewportBefore.convertToViewportPoint(origAnnot.rect[0], origAnnot.rect[1]);
    const p2 = viewportBefore.convertToViewportPoint(origAnnot.rect[2], origAnnot.rect[3]);
    const q1 = viewportAfter.convertToViewportPoint(annots[0].rect[0], annots[0].rect[1]);
    const q2 = viewportAfter.convertToViewportPoint(annots[0].rect[2], annots[0].rect[3]);
    expect(Math.min(q1[0], q2[0])).toBeCloseTo(Math.min(p1[0], p2[0]), 1);
    expect(Math.min(q1[1], q2[1])).toBeCloseTo(Math.min(p1[1], p2[1]), 1);
    await rebuilt.loadingTask.destroy();
  });
});

// Native quad-based text markup (Highlight/Underline/StrikeOut/Squiggly).
// Authored raw (as a foreign tool would), with /QuadPoints over two text runs.
async function makeMarkupPdf(
  subtype: 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly',
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const ctx = doc.context;
  // Two quads in the widely supported UL, UR, LL, LR order.
  const q1 = [50, 350, 150, 350, 50, 340, 150, 340];
  const q2 = [50, 330, 120, 330, 50, 320, 120, 320];
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: subtype,
    Rect: [50, 320, 150, 350],
    QuadPoints: [...q1, ...q2],
    C: [1, 0.9, 0.3],
    F: 4,
  });
  annot.set(PDFName.of('Contents'), PDFHexString.fromText('marked text'));
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
  return doc.save();
}

describe('Native text markup', () => {
  it('imports a foreign /Highlight as an editable textmarkup with quads', async () => {
    const bytes = await makeMarkupPdf('Highlight');
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    expect(imported).toHaveLength(1);
    expect(imported[0].kind).toBe('textmarkup');
    expect(imported[0].markupType).toBe('highlight');
    expect(imported[0].note).toBe('marked text');
    // Two quads → 8 numbers.
    expect(imported[0].quads).toHaveLength(8);
    expect(imported[0].importedOriginal).toMatchObject({ subtype: 'Highlight' });
    // bbox spans y from 320..350 in PDF → normalized from the top.
    expect(imported[0].x).toBeCloseTo(50 / 300, 4);
    expect(imported[0].w).toBeCloseTo(100 / 300, 4);
    await pdf.loadingTask.destroy();
  });

  it('maps each markup subtype to its style', async () => {
    for (const [sub, mt] of [
      ['Underline', 'underline'],
      ['StrikeOut', 'strikeout'],
      ['Squiggly', 'squiggly'],
    ] as const) {
      const pdf = await loadPdf(await makeMarkupPdf(sub));
      const imported = await importPageAnnotations(await pdf.getPage(1));
      expect(imported[0].markupType).toBe(mt);
      await pdf.loadingTask.destroy();
    }
  });

  it('round-trips a /Highlight through commit — one native annotation with QuadPoints, no duplicate', async () => {
    const bytes = await makeMarkupPdf('Highlight');
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    await pdf.loadingTask.destroy();

    const file = makeFile('a.pdf', bytes);
    const files = new Map([['a.pdf', file]]);
    const workspace: Workspace = {
      documents: [makeDoc('a#0', file, [{ ...pageRef('a.pdf'), annotations: imported }])],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const annots = (await (await rebuilt.getPage(1)).getAnnotations()) as {
      subtype: string;
      quadPoints?: unknown;
      contentsObj?: { str: string };
    }[];
    expect(annots).toHaveLength(1); // original stripped, not duplicated
    expect(annots[0].subtype).toBe('Highlight');
    expect(annots[0].quadPoints).toBeTruthy(); // QuadPoints survived
    expect(annots[0].contentsObj?.str).toBe('marked text');
    await rebuilt.loadingTask.destroy();
  });

  it('reprojects quads on page rotation (via rotateAnnotationRect)', async () => {
    const { rotateAnnotationRect } = await import('../src/renderer/state/reducer');
    const a = {
      id: 'm',
      kind: 'textmarkup' as const,
      markupType: 'highlight' as const,
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.05,
      color: '#ffe14a',
      quads: [0.1, 0.2, 0.4, 0.25],
    };
    const r = rotateAnnotationRect(a, 90);
    expect(r.quads).toHaveLength(4);
    // A 90° turn swaps axes; the quad's new bbox matches the annotation's.
    const [qx0, qy0, qx1, qy1] = r.quads!;
    expect(Math.min(qx0, qx1)).toBeCloseTo(r.x, 5);
    expect(Math.min(qy0, qy1)).toBeCloseTo(r.y, 5);
  });

  it('deleting an imported markup strips the original (via removedImportedOriginals)', async () => {
    const bytes = await makeMarkupPdf('Underline');
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    await pdf.loadingTask.destroy();

    const file = makeFile('a.pdf', bytes);
    const files = new Map([['a.pdf', file]]);
    // The user removed it: no live annotation, but its fingerprint tombstoned.
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', file, [
          { ...pageRef('a.pdf'), annotations: [], removedImportedOriginals: [imported[0].importedOriginal!] },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const annots = await (await rebuilt.getPage(1)).getAnnotations();
    expect(annots).toHaveLength(0); // the native underline is gone
    await rebuilt.loadingTask.destroy();
  });
});

// Native /Text sticky notes as editable annotations.
async function makeStickyNotePdf(rect: [number, number, number, number] = [40, 300, 58, 318]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const ctx = doc.context;
  const annot = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: rect, Name: 'Note', C: [1, 0.85, 0.2] });
  annot.set(PDFName.of('Contents'), PDFHexString.fromText('a sticky note'));
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
  return doc.save();
}

describe('Native /Text sticky notes', () => {
  it('imports a /Text as an editable note with its text', async () => {
    const pdf = await loadPdf(await makeStickyNotePdf());
    const imported = await importPageAnnotations(await pdf.getPage(1));
    expect(imported).toHaveLength(1);
    expect(imported[0].kind).toBe('note');
    expect(imported[0].note).toBe('a sticky note');
    expect(imported[0].importedOriginal).toMatchObject({ subtype: 'Text' });
    await pdf.loadingTask.destroy();
  });

  it('gives a zero-size /Text rect a visible icon box', async () => {
    const pdf = await loadPdf(await makeStickyNotePdf([40, 300, 40, 300])); // degenerate
    const imported = await importPageAnnotations(await pdf.getPage(1));
    expect(imported).toHaveLength(1); // NOT dropped
    expect(imported[0].w).toBeGreaterThan(0);
    expect(imported[0].h).toBeGreaterThan(0);
    await pdf.loadingTask.destroy();
  });

  it('round-trips a note through commit as one /Text, not a duplicate', async () => {
    const bytes = await makeStickyNotePdf();
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    await pdf.loadingTask.destroy();
    const file = makeFile('a.pdf', bytes);
    const files = new Map([['a.pdf', file]]);
    const workspace: Workspace = {
      documents: [makeDoc('a#0', file, [{ ...pageRef('a.pdf'), annotations: imported }])],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const annots = (await (await rebuilt.getPage(1)).getAnnotations()) as {
      subtype: string;
      contentsObj?: { str: string };
    }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].subtype).toBe('Text');
    expect(annots[0].contentsObj?.str).toBe('a sticky note');
    await rebuilt.loadingTask.destroy();
  });

  it('editing a note commits the edited text without duplicating', async () => {
    const bytes = await makeStickyNotePdf();
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    await pdf.loadingTask.destroy();
    const edited = { ...imported[0], note: 'edited sticky' };
    const file = makeFile('a.pdf', bytes);
    const files = new Map([['a.pdf', file]]);
    const workspace: Workspace = {
      documents: [makeDoc('a#0', file, [{ ...pageRef('a.pdf'), annotations: [edited] }])],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const rebuilt = await loadPdf(await buildCommitBytes(plan));
    const annots = (await (await rebuilt.getPage(1)).getAnnotations()) as {
      subtype: string;
      contentsObj?: { str: string };
    }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].contentsObj?.str).toBe('edited sticky');
    await rebuilt.loadingTask.destroy();
  });
});

describe('the FreeText appearance carries the authored colour', () => {
  // The other half of N4's pair. The on-page note measured 1.11:1 while the
  // panel showed it at full contrast, which reads as a broken appearance
  // stream; the stream was in fact correct and the overlay was painting over
  // it (pinned in annotation-manipulation.test.ts). This pins the half that
  // was proved innocent, so a later edit here cannot quietly become the cause.
  it('strokes the border and fills the text in the note colour, not the ground', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const page: ExportPage = {
      bytes: await doc.save(),
      sourceKey: 'src',
      pageIndex: 0,
      annotations: [
        {
          kind: 'freetext',
          x: 0.62,
          y: 0.288,
          w: 0.31,
          h: 0.062,
          color: '#e8503a',
          note: 'Redact before circulation',
        },
      ],
    };
    const out = await PDFDocument.load(await buildPdf([page], undefined, 'src'));
    const annots = out.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
    let ft: PDFDict | null = null;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookupMaybe(i, PDFDict);
      if (a && String(a.lookup(PDFName.of('Subtype'))) === '/FreeText') ft = a;
    }
    expect(ft, 'no FreeText annotation was emitted').not.toBeNull();
    const ap = ft!.lookupMaybe(PDFName.of('AP'), PDFDict)!;
    const content = new TextDecoder().decode(
      (ap.lookup(PDFName.of('N')) as PDFRawStream).getContents(),
    );
    // #e8503a as PDF operands, to three places — enough to be unmistakably the
    // authored colour and not the near-white ground beside it.
    const rgb = /0\.909\d* 0\.313\d* 0\.227\d*/;
    expect(content, 'the border is no longer stroked in the note colour').toMatch(
      new RegExp(`${rgb.source} RG`),
    );
    expect(content, 'the text is no longer filled in the note colour').toMatch(
      new RegExp(`${rgb.source} rg`),
    );
    // The ground stays the pale paper the body is read against.
    expect(content).toMatch(/0\.98 0\.98 0\.96 rg/);
    // And the /DA is a LITERAL string. Its content IS content-stream syntax, so
    // a UTF-16BE hex string puts a NUL between every digit and a reader that
    // regenerates the appearance parses none of it — pdf.js reports
    // `parseDefaultAppearance ... Invalid number: (charCode 0)` and falls back
    // to a colour and size this file never asked for.
    const da = ft!.lookup(PDFName.of('DA'));
    expect(da, 'the FreeText /DA is not a literal string').toBeInstanceOf(PDFString);
    expect((da as PDFString).decodeText()).toMatch(new RegExp(`${rgb.source} rg`));
  });
});

describe('an imported annotation keeps the colour the file carries', () => {
  // Found while verifying N4 against the shipped screenshot: every accent bar
  // in the comment list was a SUBTYPE DEFAULT. A highlight authored `#f7c948`
  // came back `#ffe14a` and an ink stroke authored `#e8503a` came back
  // `#2f6fed`, while the page kept drawing the authored colours out of their
  // appearance streams — so the list and the page disagreed about every mark.
  //
  // Cause: pdf.js hands `/C` back as a **Uint8ClampedArray**, and
  // `Array.isArray` is false for one, so the reader returned null every time
  // and the default took over. The container was never the question.
  it('reads a Uint8ClampedArray /C, which is what pdf.js actually hands back', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const page: ExportPage = {
      bytes: await doc.save(),
      sourceKey: 'src',
      pageIndex: 0,
      annotations: [
        { kind: 'highlight', x: 0.1, y: 0.3, w: 0.4, h: 0.02, color: '#f7c948', note: 'h' },
        {
          kind: 'ink',
          x: 0.1,
          y: 0.4,
          w: 0.3,
          h: 0.03,
          color: '#e8503a',
          strokes: [[0.1, 0.41, 0.35, 0.42]],
        },
      ],
    };
    const bytes = await buildPdf([page], undefined, "src");
    const pdf = await loadPdf(bytes);
    const imported = await importPageAnnotations(await pdf.getPage(1));
    await pdf.loadingTask.destroy();
    const byKind = new Map(imported.map((a) => [a.kind, a.color]));
    // A committed highlight round-trips as a native /Highlight text markup.
    expect(byKind.get('textmarkup'), 'the highlight fell back to its default').toBe('#f7c948');
    expect(byKind.get('ink'), 'the ink fell back to its default').toBe('#e8503a');
  });
});
