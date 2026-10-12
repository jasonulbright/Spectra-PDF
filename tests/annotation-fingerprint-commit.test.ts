import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import type { PDFContext } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { importPageAnnotations } from '../src/renderer/lib/annotation-import';
import { readRawAnnotationStyles } from '../src/renderer/lib/annotation-raw-style';
import { entryOf, importedRect } from '../src/renderer/lib/annotation-fingerprint';
import { holdsLowercaseEscape, normalizeEscapedNames } from '../src/renderer/lib/pdf-name-normalize';
import { planCommit, buildCommitBytes } from '../src/renderer/lib/workspace-commit';
import type { OpenDocument, OpenFile, PageAnnotation, PageRef, Workspace } from '../src/renderer/state/types';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return (await pdfjs.getDocument({ data: bytes.slice() }).promise) as PDFDocumentProxy;
}

/** One page holding one annotation the caller builds. */
async function pageWith(build: (ctx: PDFContext) => PDFDict): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(build(doc.context))]));
  return doc.save({ useObjectStreams: false });
}

function appearance(ctx: PDFContext): PDFDict {
  return ctx.obj({ N: ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] })) });
}

async function importAll(bytes: Uint8Array): Promise<PageAnnotation[]> {
  const pdf = await loadPdf(bytes);
  const styles = await readRawAnnotationStyles(bytes);
  const imported = await importPageAnnotations(await pdf.getPage(1), styles?.[0]);
  await pdf.loadingTask.destroy();
  return imported;
}

function makeFile(path: string, buffer: Uint8Array): OpenFile {
  return { path, workingPath: `${path}.working`, name: path, pageCount: 1, buffer, dirty: false, undoStack: [], redoStack: [] };
}

/** One import + commit cycle of every annotation the page holds. */
async function commitCycle(bytes: Uint8Array): Promise<Uint8Array> {
  const imported = await importAll(bytes);
  const file = makeFile('a.pdf', bytes);
  const page: PageRef = { id: 'a.pdf#p0', sourceDocId: 'a.pdf', sourcePageIndex: 0, rotation: 0, width: 0, height: 0, annotations: imported };
  const doc: OpenDocument = { ...file, id: 'a.pdf#0', name: file.name, pages: [page], pageCount: 1 };
  const workspace: Workspace = { documents: [doc] };
  const [plan] = planCommit(workspace, new Map([['a.pdf', file]]), ['a.pdf']);
  return buildCommitBytes(plan);
}

async function subtypes(bytes: Uint8Array): Promise<string[]> {
  const pdf = await loadPdf(bytes);
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string }[];
  await pdf.loadingTask.destroy();
  return annots.map((a) => a.subtype);
}

/** pdf.js's rectangle for the page's one annotation beside this module's. */
async function bothRects(bytes: Uint8Array): Promise<{ pdfjs: number[]; ours: number[] }> {
  const pdf = await loadPdf(bytes);
  const [annot] = (await (await pdf.getPage(1)).getAnnotations()) as { rect: number[]; subtype: string }[];
  await pdf.loadingTask.destroy();
  const doc = await PDFDocument.load(bytes);
  const dict = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
  return { pdfjs: Array.from(annot.rect), ours: importedRect(dict, annot.subtype) };
}

const QUAD = [100, 520, 200, 520, 100, 500, 200, 500];

/** Each annotation the importer recognizes, drawn by pdf.js because it has
 *  no /AP, with a /Rect that differs from what pdf.js draws. */
const NO_APPEARANCE: [string, (ctx: PDFContext) => PDFDict][] = [
  ['Highlight', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Highlight', QuadPoints: QUAD, Rect: [98, 498, 202, 522], C: [1, 1, 0] })],
  ['Underline', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Underline', QuadPoints: QUAD, Rect: [98, 498, 202, 522], C: [0, 0, 1] })],
  ['StrikeOut', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'StrikeOut', QuadPoints: QUAD, Rect: [98, 498, 202, 522], C: [1, 0, 0] })],
  ['Squiggly', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Squiggly', QuadPoints: QUAD, Rect: [98, 498, 202, 522], C: [0, 1, 0] })],
  ['Line', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Line', L: [40, 100, 160, 140], Rect: [36, 96, 164, 144], C: [0, 0, 0], BS: { W: 2 } })],
  ['Ink', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150, 180, 120]], Rect: [0, 0, 10, 10], C: [0, 0, 1] })],
  ['Polygon', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Polygon', Vertices: [100, 100, 150, 150, 180, 100], Rect: [0, 0, 10, 10], C: [1, 0, 0] })],
  ['PolyLine', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'PolyLine', Vertices: [100, 100, 150, 150, 180, 100], Rect: [0, 0, 10, 10], C: [1, 0, 0] })],
];

describe('the fingerprint rectangle agrees with pdf.js', () => {
  for (const [subtype, build] of NO_APPEARANCE) {
    it(`for ${subtype} with no appearance`, async () => {
      const { pdfjs: theirs, ours } = await bothRects(await pageWith(build));
      ours.forEach((v, k) => expect(v).toBeCloseTo(theirs[k], 3));
    });
  }

  it('for an unreadable /Rect, read as [0 0 0 0]', async () => {
    const { pdfjs: theirs, ours } = await bothRects(await pageWith((ctx) =>
      ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 50], C: [1, 0, 0], AP: appearance(ctx) })));
    expect(ours).toEqual(theirs);
    expect(ours).toEqual([0, 0, 0, 0]);
  });

  it('for a Line whose /Rect misses its line, widened by the border', async () => {
    const { pdfjs: theirs, ours } = await bothRects(await pageWith((ctx) =>
      ctx.obj({ Type: 'Annot', Subtype: 'Line', L: [100, 100, 160, 140], Rect: [0, 0, 10, 10], C: [0, 0, 0], Border: [0, 0, 3] })));
    ours.forEach((v, k) => expect(v).toBeCloseTo(theirs[k], 3));
  });

  it('for an annotation with an appearance, its own /Rect', async () => {
    const { pdfjs: theirs, ours } = await bothRects(await pageWith((ctx) =>
      ctx.obj({ Type: 'Annot', Subtype: 'Highlight', QuadPoints: QUAD, Rect: [202, 522, 98, 498], C: [1, 1, 0], AP: appearance(ctx) })));
    expect(ours).toEqual(theirs);
    expect(ours).toEqual([98, 498, 202, 522]);
  });
});

describe('a commit replaces each original exactly once', () => {
  for (const [subtype, build] of NO_APPEARANCE) {
    it(`${subtype} with no appearance`, async () => {
      const source = await pageWith(build);
      expect(await importAll(source)).toHaveLength(1);
      const once = await commitCycle(source);
      expect(await subtypes(once)).toEqual([subtype]);
      expect(await subtypes(await commitCycle(once))).toEqual([subtype]);
    });
  }

  for (const [label, rect] of [['a null in its /Rect', [500, 700, 520, null]], ['five numbers in its /Rect', [500, 700, 520, 720, 1]], ['no /Rect', null]] as const) {
    it(`a /Text note with ${label}`, async () => {
      const source = await pageWith((ctx) => {
        const note = ctx.obj({ Type: 'Annot', Subtype: 'Text', F: 4 });
        note.set(PDFName.of('Contents'), PDFHexString.fromText('Check'));
        if (rect) note.set(PDFName.of('Rect'), ctx.obj([...rect]));
        return note;
      });
      const once = await commitCycle(source);
      expect(await subtypes(once)).toEqual(['Text']);
      expect(await subtypes(await commitCycle(once))).toEqual(['Text']);
    });
  }

  it('a /Subtype written with a lowercase hex escape', async () => {
    // pdf-lib writes `#` itself as `#23`, so the escape is put into the file
    // bytes by replacing a placeholder name of the same length.
    const placeholder = await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'HighZZZight', QuadPoints: QUAD, Rect: [100, 500, 200, 520], C: [1, 1, 0], AP: appearance(ctx),
    }));
    const text = Buffer.from(placeholder).toString('latin1');
    expect(text).toContain('/HighZZZight');
    const source = new Uint8Array(Buffer.from(text.replace('/HighZZZight', '/High#6cight'), 'latin1'));
    expect(await subtypes(source)).toEqual(['Highlight']);
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Highlight']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Highlight']);
  });
});

describe('a name-typed /Contents on a text-bearing annotation', () => {
  it('is drawn in the re-authored FreeText appearance on the first commit', async () => {
    const source = await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'FreeText', Rect: [40, 300, 200, 340], Contents: 'Approved',
      DA: PDFString.of('0 g /Helv 12 Tf'), AP: appearance(ctx),
    }));
    const out = await PDFDocument.load(await commitCycle(source));
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(1);
    const freeText = annots.lookup(0, PDFDict);
    const normal = freeText.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
    expect(normal).toBeInstanceOf(PDFStream);
    const bytes = normal instanceof PDFRawStream ? decodePDFRawStream(normal).decode() : (normal as PDFStream).getContents();
    expect(Buffer.from(bytes).toString('latin1')).toContain('(Approved) Tj');
  });
});

/** A Line whose /Rect meets its line: pdf.js reports that /Rect widened by
 *  the border width, so each case reads the width back. */
function lineWith(extra: (ctx: PDFContext) => Record<string, unknown>): (ctx: PDFContext) => PDFDict {
  return (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Line', L: [40, 100, 160, 140], Rect: [36, 96, 164, 144], C: [0, 0, 0], ...extra(ctx) });
}

describe('the border width a Line is widened by', () => {
  const cases: [string, (ctx: PDFContext) => Record<string, unknown>, number][] = [
    ['/BS /W over /Border', () => ({ BS: { W: 3 }, Border: [0, 0, 5] }), 3],
    ['/BS typed /Border', () => ({ BS: { Type: 'Border', W: 3 } }), 3],
    ['/BS typed otherwise keeps the default', () => ({ BS: { Type: 'Other', W: 3 } }), 1],
    ['/BS /W as a name is no border', () => ({ BS: { W: 'Thick' } }), 1],
    ['/BS that is not a dictionary keeps the default', () => ({ BS: 3 }), 1],
    ['/BS /W wider than half the rectangle', () => ({ BS: { W: 50 } }), 1],
    ['/Border width', () => ({ Border: [0, 0, 4] }), 4],
    ['an empty /Border is no border', () => ({ Border: [] }), 1],
    ['a /Border of two numbers keeps the default', () => ({ Border: [0, 0] }), 1],
    ['no /BS and no /Border', () => ({}), 1],
  ];
  for (const [label, extra, width] of cases) {
    it(label, async () => {
      const { pdfjs: theirs, ours } = await bothRects(await pageWith(lineWith(extra)));
      ours.forEach((v, k) => expect(v).toBeCloseTo(theirs[k], 3));
      expect(ours).toEqual([36 - width, 96 - width, 164 + width, 144 + width]);
    });
  }
});

describe('a path whose /Rect meets it keeps its /Rect', () => {
  const meets: [string, (ctx: PDFContext) => PDFDict][] = [
    ['Ink', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [90, 90, 160, 160], C: [0, 0, 1] })],
    ['Polygon', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Polygon', Vertices: [100, 100, 150, 150, 180, 100], Rect: [90, 90, 190, 160], C: [1, 0, 0] })],
    ['PolyLine', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'PolyLine', Vertices: [100, 100, 150, 150, 180, 100], Rect: [90, 90, 190, 160], C: [1, 0, 0] })],
  ];
  for (const [subtype, build] of meets) {
    it(subtype, async () => {
      const { pdfjs: theirs, ours } = await bothRects(await pageWith(build));
      expect(ours).toEqual(theirs);
      expect(ours).toEqual(subtype === 'Ink' ? [90, 90, 160, 160] : [90, 90, 190, 160]);
    });
  }
});

describe('coordinates a 32-bit float cannot hold exactly', () => {
  it('agree with pdf.js for quadrilaterals and vertices', async () => {
    const quad = [100.1, 520.3, 200.7, 520.3, 100.1, 500.9, 200.7, 500.9];
    const highlight = await bothRects(await pageWith((ctx) =>
      ctx.obj({ Type: 'Annot', Subtype: 'Highlight', QuadPoints: quad, Rect: [0, 0, 1, 1], C: [1, 1, 0] })));
    highlight.ours.forEach((v, k) => expect(v).toBeCloseTo(highlight.pdfjs[k], 4));
    const polygon = await bothRects(await pageWith((ctx) =>
      ctx.obj({ Type: 'Annot', Subtype: 'Polygon', Vertices: [100.1, 100.3, 150.7, 150.9], Rect: [0, 0, 1, 1], C: [1, 0, 0] })));
    polygon.ours.forEach((v, k) => expect(v).toBeCloseTo(polygon.pdfjs[k], 4));
  });
});

describe('markups and ink seen at the [0 0 0 0] fallback', () => {
  const fallback: [string, string, (ctx: PDFContext) => PDFDict][] = [
    ['a Highlight with an appearance and no /Rect', 'Highlight', (ctx) =>
      ctx.obj({ Type: 'Annot', Subtype: 'Highlight', QuadPoints: QUAD, C: [1, 1, 0], AP: appearance(ctx) })],
    ['an Ink with an appearance and no /Rect', 'Ink', (ctx) =>
      ctx.obj({ Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], C: [0, 0, 1], AP: appearance(ctx) })],
    ['an Ink with no appearance whose stroke box meets the origin', 'Ink', (ctx) =>
      ctx.obj({ Type: 'Annot', Subtype: 'Ink', InkList: [[1, 1, 50, 50]], C: [0, 0, 1] })],
  ];
  for (const [label, subtype, build] of fallback) {
    it(`${label} commits to exactly one annotation`, async () => {
      const source = await pageWith(build);
      const { pdfjs: theirs, ours } = await bothRects(source);
      ours.forEach((v, k) => expect(v).toBeCloseTo(theirs[k], 3));
      expect(await importAll(source)).toHaveLength(1);
      const once = await commitCycle(source);
      expect(await subtypes(once)).toEqual([subtype]);
      expect(await subtypes(await commitCycle(once))).toEqual([subtype]);
    });
  }
});

describe('shapes with an appearance and no readable /Rect', () => {
  // pdf.js reports each at [0 0 0 0]. The importer makes nothing of a
  // zero-size shape, so no fingerprint names it: the original is neither
  // stripped nor duplicated.
  const shapes: [string, (ctx: PDFContext) => PDFDict][] = [
    ['Line', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Line', L: [40, 100, 160, 140], C: [0, 0, 0], AP: appearance(ctx) })],
    ['Polygon', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Polygon', Vertices: [100, 100, 150, 150, 180, 100], Rect: [10, 10, 50], C: [1, 0, 0], AP: appearance(ctx) })],
    ['PolyLine', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'PolyLine', Vertices: [100, 100, 150, 150, 180, 100], C: [1, 0, 0], AP: appearance(ctx) })],
    ['Square', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 50, null], C: [1, 0, 0], AP: appearance(ctx) })],
    ['Circle', (ctx) => ctx.obj({ Type: 'Annot', Subtype: 'Circle', C: [1, 0, 0], AP: appearance(ctx) })],
  ];
  for (const [subtype, build] of shapes) {
    it(`${subtype} stays exactly one annotation through two commits`, async () => {
      const source = await pageWith(build);
      const { pdfjs: theirs, ours } = await bothRects(source);
      expect(ours).toEqual(theirs);
      expect(ours).toEqual([0, 0, 0, 0]);
      const once = await commitCycle(source);
      expect(await subtypes(once)).toEqual([subtype]);
      expect(await subtypes(await commitCycle(once))).toEqual([subtype]);
    });
  }
});

/** Dash patterns (12.5.4) and the border width pdf.js is left with after
 *  them, for a stated width of 3. */
const DASHES: [string, (ctx: PDFContext) => Record<string, unknown>, number][] = [
  ['/BS /D of zeros', () => ({ BS: { W: 3, D: [0] } }), 0],
  ['/BS /D that is a number', () => ({ BS: { W: 3, D: 5 } }), 0],
  ['/BS /D that is zero', () => ({ BS: { W: 3, D: 0 } }), 3],
  ['/BS /D with a negative entry', () => ({ BS: { W: 3, D: [3, -1] } }), 0],
  ['/BS /D with a name', () => ({ BS: { W: 3, D: ['Dash'] } }), 0],
  ['/BS /D that is empty', () => ({ BS: { W: 3, D: [] } }), 3],
  ['/BS /D that is a dash', () => ({ BS: { W: 3, D: [3, 2] } }), 3],
  ['a fourth /Border entry of zeros', (ctx) => ({ Border: ctx.obj([0, 0, 3, [0]]) }), 0],
  ['a fourth /Border entry that is a number', (ctx) => ({ Border: ctx.obj([0, 0, 3, 5]) }), 0],
  ['a fourth /Border entry that is a dash', (ctx) => ({ Border: ctx.obj([0, 0, 3, [2, 1]]) }), 3],
  ['a /Border of five entries', (ctx) => ({ Border: ctx.obj([0, 0, 3, [0], 9]) }), 3],
];

describe('a dash pattern pdf.js rejects leaves no border width', () => {
  for (const [label, extra, width] of DASHES) {
    const bw = width || 1;
    it(`Ink: ${label}`, async () => {
      const source = await pageWith((ctx) => ctx.obj({
        Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], ...extra(ctx),
      }));
      const { pdfjs: theirs, ours } = await bothRects(source);
      expect(ours).toEqual(theirs);
      expect(ours).toEqual([100 - 2 * bw, 100 - 2 * bw, 150 + 2 * bw, 150 + 2 * bw]);
      expect(await importAll(source)).toHaveLength(1);
      const once = await commitCycle(source);
      expect(await subtypes(once)).toEqual(['Ink']);
      expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
    });
    it(`Line: ${label}`, async () => {
      const { pdfjs: theirs, ours } = await bothRects(await pageWith(lineWith(extra)));
      ours.forEach((v, k) => expect(v).toBeCloseTo(theirs[k], 3));
      expect(ours).toEqual([36 - bw, 96 - bw, 164 + bw, 144 + bw]);
    });
    for (const subtype of ['Polygon', 'PolyLine']) {
      it(`${subtype}: ${label}`, async () => {
        const { pdfjs: theirs, ours } = await bothRects(await pageWith((ctx) => ctx.obj({
          Type: 'Annot', Subtype: subtype, Vertices: [100, 100, 150, 150], Rect: [10, 10, 20, 20], C: [1, 0, 0], ...extra(ctx),
        })));
        expect(ours).toEqual(theirs);
        expect(ours).toEqual([100 - 2 * bw, 100 - 2 * bw, 150 + 2 * bw, 150 + 2 * bw]);
      });
    }
  }
});

/** A page holding a /Text parent and one reply to it. */
async function replyPage(replyType: string, ownContents?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 600]);
  const ctx = doc.context;
  const parent = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4 });
  parent.set(PDFName.of('Contents'), PDFHexString.fromText('Parent note'));
  const parentRef = ctx.register(parent);
  const reply = ctx.obj({
    Type: 'Annot', Subtype: 'Highlight', Rect: [98, 498, 202, 522], QuadPoints: QUAD, C: [1, 1, 0], IRT: parentRef, RT: replyType,
  });
  if (ownContents !== undefined) reply.set(PDFName.of('Contents'), PDFHexString.fromText(ownContents));
  page.node.set(PDFName.of('Annots'), ctx.obj([parentRef, ctx.register(reply)]));
  return doc.save();
}

describe('a reply to another annotation (12.5.6.2)', () => {
  it('a group reply imports with its parent text and stays one annotation through two commits', async () => {
    const source = await replyPage('Group');
    const highlight = (await importAll(source)).find((a) => a.importedOriginal?.subtype === 'Highlight');
    expect(highlight?.note).toBe('Parent note');
    const once = await commitCycle(source);
    expect((await subtypes(once)).sort()).toEqual(['Highlight', 'Text']);
    expect((await subtypes(await commitCycle(once))).sort()).toEqual(['Highlight', 'Text']);
  });

  it('a plain reply keeps its own text and stays one annotation through two commits', async () => {
    const source = await replyPage('R', 'Own note');
    const highlight = (await importAll(source)).find((a) => a.importedOriginal?.subtype === 'Highlight');
    expect(highlight?.note).toBe('Own note');
    const once = await commitCycle(source);
    expect((await subtypes(once)).sort()).toEqual(['Highlight', 'Text']);
    expect((await subtypes(await commitCycle(once))).sort()).toEqual(['Highlight', 'Text']);
  });
});

describe('dash entries pdf.js resolves in unusual ways', () => {
  const inkWith = (dash: (ctx: PDFContext) => unknown) => (ctx: PDFContext) => ctx.obj({
    Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1],
    BS: ctx.obj({ W: 2, D: dash(ctx) as never }),
  });

  it('a reference to an object the file does not hold reads as null, a valid 0', async () => {
    const source = await pageWith(inkWith((ctx) => ctx.obj([3, PDFRef.of(999)])));
    const { pdfjs: theirs, ours } = await bothRects(source);
    expect(ours).toEqual(theirs);
    expect(ours).toEqual([96, 96, 154, 154]);
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Ink']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
  });

  it('a string of 200000 characters is read without failing the commit', async () => {
    const source = await pageWith(inkWith((ctx) => ctx.obj([PDFString.of('a'.repeat(200_000))])));
    const { pdfjs: theirs, ours } = await bothRects(source);
    expect(ours).toEqual(theirs);
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Ink']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
  });
});

describe('a coordinate array larger than a call can take as arguments', () => {
  it('an Ink of 200000 points imports, fingerprints as pdf.js reports it, and stays one annotation', async () => {
    const path: number[] = [];
    for (let i = 0; i < 200_000; i++) path.push(20 + (i % 260), 20 + ((i * 7) % 360));
    const source = await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [path], Rect: [0, 0, 300, 400], C: [0, 0, 1],
    }));
    const { pdfjs: theirs, ours } = await bothRects(source);
    expect(ours).toEqual(theirs);
    expect(await importAll(source)).toHaveLength(1);
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Ink']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
  }, 120_000);
});

/** Border entries pdf.js reads by key presence and by JavaScript falsiness,
 *  each with the border width pdf.js is left with. */
const PRESENCE: [string, (ctx: PDFContext) => Record<string, unknown>, number][] = [
  ['/BS null hides /Border', (ctx) => ({ BS: PDFNull, Border: ctx.obj([0, 0, 3]) }), 1],
  ['/BS /Type of an empty string is no type', () => ({ BS: { Type: PDFString.of(''), W: 3 } }), 3],
  ['/BS /Type 0 is no type', () => ({ BS: { Type: 0, W: 3 } }), 3],
  ['/BS /Type false is no type', () => ({ BS: { Type: false, W: 3 } }), 3],
];

describe('border entries read by presence and falsiness', () => {
  for (const [label, extra, width] of PRESENCE) {
    it(`Ink: ${label}`, async () => {
      const source = await pageWith((ctx) => ctx.obj({
        Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], ...extra(ctx),
      }));
      const { pdfjs: theirs, ours } = await bothRects(source);
      expect(ours).toEqual(theirs);
      expect(ours).toEqual([100 - 2 * width, 100 - 2 * width, 150 + 2 * width, 150 + 2 * width]);
      expect(await importAll(source)).toHaveLength(1);
      const once = await commitCycle(source);
      expect(await subtypes(once)).toEqual(['Ink']);
      expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
    });
    it(`Line: ${label}`, async () => {
      const { pdfjs: theirs, ours } = await bothRects(await pageWith(lineWith(extra)));
      ours.forEach((v, k) => expect(v).toBeCloseTo(theirs[k], 3));
      expect(ours).toEqual([36 - width, 96 - width, 164 + width, 144 + width]);
    });
    for (const subtype of ['Polygon', 'PolyLine']) {
      it(`${subtype}: ${label}`, async () => {
        const { pdfjs: theirs, ours } = await bothRects(await pageWith((ctx) => ctx.obj({
          Type: 'Annot', Subtype: subtype, Vertices: [100, 100, 150, 150], Rect: [10, 10, 20, 20], C: [1, 0, 0], ...extra(ctx),
        })));
        expect(ours).toEqual(theirs);
        expect(ours).toEqual([100 - 2 * width, 100 - 2 * width, 150 + 2 * width, 150 + 2 * width]);
      });
    }
  }
});

/** The saved bytes with each placeholder key replaced by an escaped spelling
 *  of the same length. pdf-lib writes `#` itself as `#23`, so an escaped key
 *  reaches the file only this way. */
function withKeys(bytes: Uint8Array, keys: [string, string][]): Uint8Array {
  let text = Buffer.from(bytes).toString('latin1');
  for (const [placeholder, escaped] of keys) {
    expect(placeholder.length).toBe(escaped.length);
    expect(text).toContain(placeholder);
    text = text.split(placeholder).join(escaped);
  }
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

describe('dictionary keys written with hex escapes (7.3.5)', () => {
  it('an Ink whose /Border key is escaped matches pdf.js and stays one annotation', async () => {
    const source = withKeys(await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1],
      BZZZrder: [0, 0, 3],
    })), [['/BZZZrder', '/B#6frder']]);
    const { pdfjs: theirs, ours } = await bothRects(source);
    expect(ours).toEqual(theirs);
    expect(ours).toEqual([94, 94, 156, 156]);
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Ink']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
  });

  it('a Highlight whose /Subtype and /Contents keys are escaped is replaced once', async () => {
    const source = withKeys(await pageWith((ctx) => ctx.obj({
      Type: 'Annot', SuZZZtype: 'Highlight', QuadPoints: QUAD, Rect: [100, 500, 200, 520], C: [1, 1, 0],
      AP: appearance(ctx), CoZZZtents: PDFString.of('x'),
    })), [['/SuZZZtype', '/Su#62type'], ['/CoZZZtents', '/Co#6etents']]);
    const imported = await importAll(source);
    expect(imported).toHaveLength(1);
    expect(imported[0].note).toBe('x');
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Highlight']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Highlight']);
  });

  it('a group reply whose /IRT key is escaped takes its parent text', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    const ctx = doc.context;
    const parent = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4 });
    parent.set(PDFName.of('Contents'), PDFHexString.fromText('Parent note'));
    const parentRef = ctx.register(parent);
    const reply = ctx.obj({
      Type: 'Annot', Subtype: 'Highlight', Rect: [98, 498, 202, 522], QuadPoints: QUAD, C: [1, 1, 0], IZZZT: parentRef, RT: 'Group',
    });
    page.node.set(PDFName.of('Annots'), ctx.obj([parentRef, ctx.register(reply)]));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/IZZZT', '/I#52T']]);
    const highlight = (await importAll(source)).find((a) => a.importedOriginal?.subtype === 'Highlight');
    expect(highlight?.note).toBe('Parent note');
    const once = await commitCycle(source);
    expect((await subtypes(once)).sort()).toEqual(['Highlight', 'Text']);
    expect((await subtypes(await commitCycle(once))).sort()).toEqual(['Highlight', 'Text']);
  });
});

describe('the decoded-key scan', () => {
  it('decodes no key in a dictionary whose keys carry no escape, and every key once one does', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({ Type: 'Annot', Subtype: 'Ink', Rect: [0, 0, 1, 1], C: [0, 0, 1] });
    const decode = vi.spyOn(PDFName.prototype, 'asBytes');
    try {
      expect(entryOf(dict, 'BS')).toBeUndefined();
      expect(entryOf(dict, 'Border')).toBeUndefined();
      expect(decode).not.toHaveBeenCalled();
      dict.set(PDFName.of('B#6frder'), doc.context.obj([0, 0, 3]));
      // With an escaped key present every key is read by decoded spelling, so
      // the later of two spellings can win.
      expect(entryOf(dict, 'Border')).toBeInstanceOf(PDFArray);
      expect(decode).toHaveBeenCalledTimes(dict.entries().length);
    } finally {
      decode.mockRestore();
    }
  });
});

describe('an annotation whose /OC is null', () => {
  it('is re-authored without an /OC key', async () => {
    const source = await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'Square', Rect: [20, 300, 80, 320], C: [1, 0, 0], AP: appearance(ctx), OC: null,
    }));
    expect(await importAll(source)).toHaveLength(1);
    const out = await PDFDocument.load(await commitCycle(source));
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(1);
    expect(annots.lookup(0, PDFDict).get(PDFName.of('OC'), true)).toBeUndefined();
  });
});

describe('a key whose `#` the file wrote as #23 (7.3.5)', () => {
  const ink = (extra: (ctx: PDFContext) => Record<string, unknown>) => (ctx: PDFContext) => ctx.obj({
    Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], ...extra(ctx),
  });
  const cases: [string, (ctx: PDFContext) => Record<string, unknown>, [string, string]][] = [
    ['/B#2353 is not /BS', () => ({ BZZZZZ: { W: 3 } }), ['/BZZZZZ', '/B#2353']],
    ['/A#2350 is not /AP', (ctx) => ({ AZZZZZ: appearance(ctx) }), ['/AZZZZZ', '/A#2350']],
    ['/S#2375btype is not /Subtype', () => ({ SZZZZZbtype: 'Highlight' }), ['/SZZZZZbtype', '/S#2375btype']],
  ];
  for (const [label, extra, key] of cases) {
    it(`${label}: the Ink matches pdf.js and stays one annotation`, async () => {
      const source = withKeys(await pageWith(ink(extra)), [key]);
      const { pdfjs: theirs, ours } = await bothRects(source);
      expect(ours).toEqual(theirs);
      expect(ours).toEqual([98, 98, 152, 152]);
      expect(await importAll(source)).toHaveLength(1);
      const once = await commitCycle(source);
      expect(await subtypes(once)).toEqual(['Ink']);
      expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
    });
  }

  it('/O#2343 is not /OC: the replacement carries no layer', async () => {
    const source = withKeys(await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'Square', Rect: [20, 300, 80, 320], C: [1, 0, 0], AP: appearance(ctx),
      OZZZZZ: ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Layer') })),
    })), [['/OZZZZZ', '/O#2343']]);
    expect(await importAll(source)).toHaveLength(1);
    const out = await PDFDocument.load(await commitCycle(source));
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(1);
    expect(entryOf(annots.lookup(0, PDFDict), 'OC')).toBeUndefined();
  });
});

describe('one key spelt two ways: the later one counts, as in pdf.js', () => {
  const cases: [string, Record<string, unknown>, number][] = [
    ['plain then escaped', { Border: [0, 0, 1], BZZZrder: [0, 0, 3] }, 3],
    ['escaped then plain', { BZZZrder: [0, 0, 3], Border: [0, 0, 1] }, 1],
  ];
  for (const [label, borders, width] of cases) {
    it(`${label}: width ${width}`, async () => {
      const source = withKeys(await pageWith((ctx) => ctx.obj({
        Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], ...borders,
      })), [['/BZZZrder', '/B#6frder']]);
      const { pdfjs: theirs, ours } = await bothRects(source);
      expect(ours).toEqual(theirs);
      expect(ours).toEqual([100 - 2 * width, 100 - 2 * width, 150 + 2 * width, 150 + 2 * width]);
      const once = await commitCycle(source);
      expect(await subtypes(once)).toEqual(['Ink']);
      expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
    });
  }
});

describe('a dimension line whose /Measure key is escaped', () => {
  const line = (key: string) => (ctx: PDFContext) => ctx.obj({
    Type: 'Annot', Subtype: 'Line', Rect: [50, 50, 200, 60], L: [60, 55, 190, 55], C: [0, 0, 0], AP: appearance(ctx),
    [key]: ctx.obj({ Type: 'Measure', R: PDFString.of('1 in = 1 ft') }),
  });
  const cases: [string, () => Promise<Uint8Array>][] = [
    ['/Measure', () => pageWith(line('Measure'))],
    ['/#4deasure', async () => withKeys(await pageWith(line('ZZZeasure')), [['/ZZZeasure', '/#4deasure']])],
  ];
  for (const [label, build] of cases) {
    it(`${label}: is refused by the measure gate and keeps its measure dictionary`, async () => {
      const source = await build();
      expect(await importAll(source)).toHaveLength(0);
      const out = await PDFDocument.load(await commitCycle(source));
      const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
      expect(annots.size()).toBe(1);
      expect(entryOf(annots.lookup(0, PDFDict), 'Measure')).toBeInstanceOf(PDFDict);
    });
  }
});

describe('an appearance state spelt two ways', () => {
  it('takes the later one, as pdf.js does: a non-stream there is no appearance', async () => {
    const source = withKeys(await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], AS: 'On',
      AP: ctx.obj({ N: ctx.obj({
        On: ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] })),
        OZZZ: PDFString.of('x'),
      }) }),
    })), [['/OZZZ', '/O#6e']]);
    const { pdfjs: theirs, ours } = await bothRects(source);
    expect(ours).toEqual(theirs);
    expect(ours).toEqual([98, 98, 152, 152]);
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Ink']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
  });
});

describe('a decoded name holding a `#` pair', () => {
  it('/AS /A#2341 names state A#41, not AA: there is no appearance, as in pdf.js', async () => {
    const source = withKeys(await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], AS: 'AZZZZZ',
      AP: ctx.obj({ N: ctx.obj({ AA: ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] })) }) }),
    })), [['/AZZZZZ', '/A#2341']]);
    const { pdfjs: theirs, ours } = await bothRects(source);
    expect(ours).toEqual(theirs);
    expect(ours).toEqual([98, 98, 152, 152]);
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Ink']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
  });
});

/** A commit that rebuilds the page without touching its annotations. */
async function commitUntouched(bytes: Uint8Array): Promise<Uint8Array> {
  const file = makeFile('a.pdf', bytes);
  const page: PageRef = { id: 'a.pdf#p0', sourceDocId: 'a.pdf', sourcePageIndex: 0, rotation: 0, width: 0, height: 0 };
  const doc: OpenDocument = { ...file, id: 'a.pdf#0', name: file.name, pages: [page], pageCount: 1 };
  const [plan] = planCommit({ documents: [doc] }, new Map([['a.pdf', file]]), ['a.pdf']);
  return buildCommitBytes(plan);
}

const inkWith = (extra: (ctx: PDFContext) => Record<string, unknown>) => (ctx: PDFContext) => ctx.obj({
  Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], ...extra(ctx),
});

describe('names the parser left with a lowercase escape are rewritten at load (7.3.5)', () => {
  it('/B#6frder becomes /Border: the model, the saved bytes and pdf.js agree on width 3', async () => {
    const source = withKeys(await pageWith(inkWith(() => ({ BZZZrder: [0, 0, 3] }))), [['/BZZZrder', '/B#6frder']]);
    const doc = await PDFDocument.load(source);
    normalizeEscapedNames(doc);
    const annot = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect(annot.get(PDFName.of('Border'))).toBeInstanceOf(PDFArray);
    const names: PDFName[] = [];
    const collect = (value: unknown): void => {
      if (value instanceof PDFName) names.push(value);
      else if (value instanceof PDFDict) {
        for (const [key, inner] of value.entries()) {
          names.push(key);
          collect(inner);
        }
      } else if (value instanceof PDFArray) value.asArray().forEach(collect);
    };
    for (const [, object] of doc.context.enumerateIndirectObjects()) collect(object);
    expect(names.some(holdsLowercaseEscape)).toBe(false);

    expect((await bothRects(source)).pdfjs).toEqual([94, 94, 156, 156]);
    // Read back without the load rewrite: the writer emitted /Border itself.
    const out = await commitUntouched(source);
    const saved = (await PDFDocument.load(out)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect(saved.get(PDFName.of('Border'))).toBeInstanceOf(PDFArray);
    expect(saved.keys().some(holdsLowercaseEscape)).toBe(false);
    expect((await bothRects(out)).pdfjs).toEqual([94, 94, 156, 156]);
  });

  it('/B#6frder on an Ink with no /AP is imported and replaced once', async () => {
    const source = withKeys(await pageWith(inkWith(() => ({ BZZZrder: [0, 0, 3] }))), [['/BZZZrder', '/B#6frder']]);
    expect(await importAll(source)).toHaveLength(1);
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Ink']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
  });

  it('/Co#6etents keeps its text for pdf.js after a commit', async () => {
    const source = withKeys(await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'Highlight', QuadPoints: QUAD, Rect: [100, 500, 200, 520], C: [1, 1, 0],
      AP: appearance(ctx), CoZZZtents: PDFString.of('x'),
    })), [['/CoZZZtents', '/Co#6etents']]);
    const pdf = await loadPdf(await commitCycle(source));
    const annots = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string; contentsObj?: { str: string } }[];
    await pdf.loadingTask.destroy();
    expect(annots.map((a) => [a.subtype, a.contentsObj?.str])).toEqual([['Highlight', 'x']]);
  });

  it('a dimension line keyed /#4deasure keeps a /Measure pdf.js reads after a commit', async () => {
    const source = withKeys(await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'Line', Rect: [50, 50, 200, 60], L: [60, 55, 190, 55], C: [0, 0, 0], AP: appearance(ctx),
      ZZZeasure: ctx.obj({ Type: 'Measure', R: PDFString.of('1 in = 1 ft') }),
    })), [['/ZZZeasure', '/#4deasure']]);
    expect(await importAll(source)).toHaveLength(0);
    const out = await commitCycle(source);
    const annot = (await PDFDocument.load(out)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect(annot.get(PDFName.of('Measure'))).toBeDefined();
    expect(annot.keys().some(holdsLowercaseEscape)).toBe(false);
  });

  it('a file that wrote #23 before a lowercase pair is read as the decoded name, the stated limit', async () => {
    // pdf.js reads this key as `#4fC`; the load rewrites it to /OC, so the
    // replacement carries the layer.
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const layer = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Layer') }));
    doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [layer], D: { ON: [layer] } }));
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [90, 90, 160, 160], C: [0, 0, 1], AP: appearance(ctx),
      ZZZZZC: layer,
    }))]));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/ZZZZZC', '/#234fC']]);
    expect(await importAll(source)).toHaveLength(1);
    const out = await commitCycle(source);
    expect(await subtypes(out)).toEqual(['Ink']);
    const annot = (await PDFDocument.load(out)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect(annot.get(PDFName.of('OC'))).toBeInstanceOf(PDFRef);
  });

  it('a plain document gains no new name', async () => {
    const doc = await PDFDocument.load(await pageWith(inkWith(() => ({ BS: { W: 3 } }))));
    const created = vi.spyOn(PDFName, 'of');
    try {
      normalizeEscapedNames(doc);
      expect(created).not.toHaveBeenCalled();
    } finally {
      created.mockRestore();
    }
  });

  it('keeps a # the file wrote as #23 and rewrites only the lowercase escape after it', async () => {
    const source = withKeys(await pageWith(inkWith(() => ({ BZZZZZZZZx: 1 }))), [['/BZZZZZZZZx', '/B#2353#6fx']]);
    const doc = await PDFDocument.load(source);
    normalizeEscapedNames(doc);
    const annot = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    const keys = annot.keys().map((key) => Buffer.from(key.asBytes()).toString('latin1'));
    expect(keys).toContain('B#53ox');
  });
});

describe('an annotation whose reading the parse has lost is left untouched', () => {
  const cases: [string, () => Promise<Uint8Array>][] = [
    ['/B#236frder (pdf.js width 1, rewritten to /Border at load)', async () =>
      withKeys(await pageWith(inkWith(() => ({ BZZZZZrder: [0, 0, 3] }))), [['/BZZZZZrder', '/B#236frder']])],
    ['/Border [0 0 1] /B#6frder [0 0 3] /Border [0 0 5]', async () => withKeys(
      await pageWith(inkWith(() => ({ QQQQQQ: [0, 0, 1], BZZZrder: [0, 0, 3], WWWWWW: [0, 0, 5] }))),
      [['/QQQQQQ', '/Border'], ['/BZZZrder', '/B#6frder'], ['/WWWWWW', '/Border']])],
    ['/AS /#6#41 against an /AP /N key /#236A', async () => withKeys(await pageWith(inkWith((ctx) => ({
      AS: 'ZZZZZ',
      AP: ctx.obj({ N: ctx.obj({ YYYYY: ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] })) }) }),
    }))), [['/ZZZZZ', '/#6#41'], ['/YYYYY', '/#236A']])],
  ];
  for (const [label, build] of cases) {
    it(`${label}: not imported, and one annotation through two commits`, async () => {
      const source = await build();
      expect(await importAll(source)).toHaveLength(0);
      const once = await commitCycle(source);
      expect(await subtypes(once)).toEqual(['Ink']);
      expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
    });
  }

  it('/IT /LineDimension /I#74 /LineArrow /IT /LineDimension: not imported', async () => {
    const source = withKeys(await pageWith((ctx) => ctx.obj({
      Type: 'Annot', Subtype: 'Line', Rect: [50, 50, 200, 60], L: [60, 55, 190, 55], C: [0, 0, 0], AP: appearance(ctx),
      QQ: 'LineDimension', ZZZZ: 'LineArrow', WW: 'LineDimension',
    })), [['/QQ', '/IT'], ['/ZZZZ', '/I#74'], ['/WW', '/IT']]);
    expect(await importAll(source)).toHaveLength(0);
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Line']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Line']);
  });

  it('a plain Ink and a /B#2353 Ink are imported as before', async () => {
    expect(await importAll(await pageWith(inkWith(() => ({}))))).toHaveLength(1);
    const escaped = withKeys(await pageWith(inkWith(() => ({ BZZZZZ: { W: 3 } }))), [['/BZZZZZ', '/B#2353']]);
    expect(await importAll(escaped)).toHaveLength(1);
  });
});

describe('a popup with no width or height', () => {
  it('indexes without failing, and only its note is imported', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const noteRef = ctx.nextRef();
    const popupRef = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [0, 0, 0, 0], Parent: noteRef, Open: false }));
    const note = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [20, 300, 40, 320], F: 4, Popup: popupRef });
    note.set(PDFName.of('Contents'), PDFHexString.fromText('note'));
    ctx.assign(noteRef, note);
    page.node.set(PDFName.of('Annots'), ctx.obj([noteRef, popupRef]));
    const imported = await importAll(await doc.save());
    expect(imported.map((a) => a.importedOriginal?.subtype)).toEqual(['Text']);
  });
});
