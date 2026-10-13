import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFObjectParser, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import type { PDFContext } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { importPage } from '../src/renderer/lib/annotation-import';
import { readRawAnnotationStyles } from '../src/renderer/lib/annotation-raw-style';
import { entryOf, importedRect } from '../src/renderer/lib/annotation-fingerprint';
import { nameIsUnresolved, nameReading, normalizeEscapedNames, pdfjsNameReading, scanNameTokens } from '../src/renderer/lib/pdf-name-normalize';
import { planCommit, buildCommitBytes } from '../src/renderer/lib/workspace-commit';
import { addFormFields } from '../src/renderer/lib/form-authoring';
import { testPython } from './support/python';
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

/** The first page's import as the workspace index records it. */
async function importFirstPage(bytes: Uint8Array): Promise<{ annotations: PageAnnotation[]; untouchedSlots: number[] }> {
  const pdf = await loadPdf(bytes);
  const styles = await readRawAnnotationStyles(bytes);
  const imported = await importPage(await pdf.getPage(1), styles?.[0]);
  await pdf.loadingTask.destroy();
  return imported;
}

async function importAll(bytes: Uint8Array): Promise<PageAnnotation[]> {
  return (await importFirstPage(bytes)).annotations;
}

function makeFile(path: string, buffer: Uint8Array): OpenFile {
  return { path, workingPath: `${path}.working`, name: path, pageCount: 1, buffer, dirty: false, undoStack: [], redoStack: [] };
}

/** One import + commit cycle of every annotation the page holds; `edit`
 *  may change the page the index recorded. */
async function commitCycle(bytes: Uint8Array, edit: (page: PageRef) => PageRef = (page) => page): Promise<Uint8Array> {
  const { annotations, untouchedSlots } = await importFirstPage(bytes);
  const file = makeFile('a.pdf', bytes);
  const page: PageRef = edit({
    id: 'a.pdf#p0', sourceDocId: 'a.pdf', sourcePageIndex: 0, rotation: 0, width: 0, height: 0, annotations,
    ...(untouchedSlots.length ? { untouchedAnnotationSlots: untouchedSlots } : {}),
  });
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

/** Page 1 holds a /Text parent; page 2 holds one reply to it. */
async function replyAcrossPages(
  reply: (ctx: PDFContext, parentRef: PDFRef) => PDFDict,
  parentText: string | null = 'Parent note',
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 600]);
  const second = doc.addPage([300, 600]);
  const ctx = doc.context;
  const parent = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4, C: [1, 0, 0], P: first.ref });
  if (parentText !== null) parent.set(PDFName.of('Contents'), PDFHexString.fromText(parentText));
  parent.set(PDFName.of('T'), PDFString.of('Parent author'));
  const parentRef = ctx.register(parent);
  first.node.set(PDFName.of('Annots'), ctx.obj([parentRef]));
  second.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(reply(ctx, parentRef))]));
  return doc.save({ useObjectStreams: false });
}

function highlightReply(replyType: string, ownContents?: string): (ctx: PDFContext, parentRef: PDFRef) => PDFDict {
  return (ctx, parentRef) => {
    const reply = ctx.obj({
      Type: 'Annot', Subtype: 'Highlight', Rect: [98, 498, 202, 522], QuadPoints: QUAD, C: [1, 1, 0], IRT: parentRef, RT: replyType,
    });
    if (ownContents !== undefined) reply.set(PDFName.of('Contents'), PDFHexString.fromText(ownContents));
    return reply;
  };
}

/** One import + commit cycle that keeps the second page only. */
async function commitSecondPageOnly(bytes: Uint8Array, edit: (page: PageRef) => PageRef = (page) => page): Promise<Uint8Array> {
  const pdf = await loadPdf(bytes);
  const styles = await readRawAnnotationStyles(bytes);
  const { annotations, untouchedSlots } = await importPage(await pdf.getPage(2), styles?.[1]);
  await pdf.loadingTask.destroy();
  const file = { ...makeFile('a.pdf', bytes), pageCount: 2 };
  const page: PageRef = edit({
    id: 'a.pdf#p1', sourceDocId: 'a.pdf', sourcePageIndex: 1, rotation: 0, width: 0, height: 0, annotations,
    ...(untouchedSlots.length ? { untouchedAnnotationSlots: untouchedSlots } : {}),
  });
  const doc: OpenDocument = { ...file, id: 'a.pdf#0', name: file.name, pages: [page], pageCount: 1 };
  const [plan] = planCommit({ documents: [doc] }, new Map([['a.pdf', file]]), ['a.pdf']);
  return buildCommitBytes(plan);
}

/** The first page's annotations as pdf.js shows them. */
async function shown(bytes: Uint8Array): Promise<{ subtype: string; text: string; inReplyTo: string | null }[]> {
  const pdf = await loadPdf(bytes);
  expect(pdf.numPages).toBe(1);
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string; contentsObj?: { str: string }; inReplyTo?: string | null }[];
  await pdf.loadingTask.destroy();
  return annots.map((a) => ({ subtype: a.subtype, text: a.contentsObj?.str ?? '', inReplyTo: a.inReplyTo ?? null }));
}

/** The keys among `names` that any object of the saved file holds, and
 *  whether the file holds a /Text annotation object, on a page or not. */
async function heldObjects(bytes: Uint8Array, names: string[]): Promise<{ keys: string[]; parent: boolean }> {
  const doc = await PDFDocument.load(bytes);
  const keys = new Set<string>();
  let parent = false;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    for (const name of names) if (obj.has(PDFName.of(name))) keys.add(name);
    if (obj.has(PDFName.of('Rect')) && obj.get(PDFName.of('Subtype')) === PDFName.of('Text')) parent = true;
  }
  return { keys: [...keys].sort(), parent };
}

describe('a group reply whose parent is on a removed page', () => {
  it('is replaced once, keeps the text pdf.js showed, and holds no link to the parent', async () => {
    const source = await replyAcrossPages(highlightReply('Group'));
    const once = await commitSecondPageOnly(source);
    expect(await shown(once)).toEqual([{ subtype: 'Highlight', text: 'Parent note', inReplyTo: null }]);
    expect(await heldObjects(once, ['IRT', 'RT'])).toEqual({ keys: [], parent: false });
    expect(await shown(await commitCycle(once))).toEqual([{ subtype: 'Highlight', text: 'Parent note', inReplyTo: null }]);
  });

  it('with text of its own is replaced once and keeps the parent text pdf.js showed', async () => {
    const source = await replyAcrossPages(highlightReply('Group', 'Own hidden'));
    const once = await commitSecondPageOnly(source);
    expect(await shown(once)).toEqual([{ subtype: 'Highlight', text: 'Parent note', inReplyTo: null }]);
    expect(await shown(await commitCycle(once))).toEqual([{ subtype: 'Highlight', text: 'Parent note', inReplyTo: null }]);
  });

  it('whose parent has no text is replaced once and stays without text', async () => {
    const source = await replyAcrossPages(highlightReply('Group', 'Own hidden'), null);
    const once = await commitSecondPageOnly(source);
    expect(await shown(once)).toEqual([{ subtype: 'Highlight', text: '', inReplyTo: null }]);
    expect(await shown(await commitCycle(once))).toEqual([{ subtype: 'Highlight', text: '', inReplyTo: null }]);
  });

  it('is removed when the user deleted it', async () => {
    const source = await replyAcrossPages(highlightReply('Group'));
    const once = await commitSecondPageOnly(source, (p) => ({
      ...p, annotations: [], removedImportedOriginals: [p.annotations![0].importedOriginal!],
    }));
    expect(await shown(once)).toEqual([]);
  });

  it('of a subtype the import leaves alone keeps the text pdf.js showed', async () => {
    const source = await replyAcrossPages((ctx, parentRef) => {
      const caret = ctx.obj({
        Type: 'Annot', Subtype: 'Caret', Rect: [98, 498, 110, 510], C: [0, 0, 1], IRT: parentRef, RT: 'Group', AP: appearance(ctx),
      });
      caret.set(PDFName.of('Contents'), PDFHexString.fromText('Own hidden'));
      caret.set(PDFName.of('T'), PDFString.of('Own author'));
      caret.set(PDFName.of('Subj'), PDFString.of('Own subject'));
      return caret;
    });
    type Seen = { contentsObj: { str: string }; titleObj: { str: string }; color: ArrayLike<number> | null };
    const read = async (bytes: Uint8Array, pageNumber: number) => {
      const pdf = await loadPdf(bytes);
      const [seen] = (await (await pdf.getPage(pageNumber)).getAnnotations()) as Seen[];
      await pdf.loadingTask.destroy();
      return { text: seen.contentsObj.str, author: seen.titleObj.str, color: seen.color ? Array.from(seen.color) : null };
    };
    const before = await read(source, 2);
    expect(before).toEqual({ text: 'Parent note', author: 'Parent author', color: [255, 0, 0] });
    const once = await commitSecondPageOnly(source);
    expect(await shown(once)).toEqual([{ subtype: 'Caret', text: 'Parent note', inReplyTo: null }]);
    expect(await read(once, 1)).toEqual(before);
    // The primary wrote no /Subj, so the group had none.
    expect(await heldObjects(once, ['IRT', 'RT', 'Subj'])).toEqual({ keys: [], parent: false });
  });

  it('a plain reply keeps its own text and is replaced once', async () => {
    const source = await replyAcrossPages(highlightReply('R', 'Own note'));
    const once = await commitSecondPageOnly(source);
    expect(await shown(once)).toEqual([{ subtype: 'Highlight', text: 'Own note', inReplyTo: null }]);
    expect(await heldObjects(once, ['IRT', 'RT'])).toEqual({ keys: [], parent: false });
    expect(await shown(await commitCycle(once))).toEqual([{ subtype: 'Highlight', text: 'Own note', inReplyTo: null }]);
  });
});

describe('a group reply whose parent dictionary the parse cannot read faithfully', () => {
  /** A /Text parent and a group reply on one page; the parent's /Contents
   *  keys are placeholders `keys` rewrites. */
  async function replyToParent(parentKeys: Record<string, string>, keys: [string, string][]): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    const ctx = doc.context;
    const parent = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4 });
    for (const [key, text] of Object.entries(parentKeys)) parent.set(PDFName.of(key), PDFString.of(text));
    const parentRef = ctx.register(parent);
    const reply = ctx.obj({
      Type: 'Annot', Subtype: 'Highlight', Rect: [98, 498, 202, 522], QuadPoints: QUAD, C: [1, 1, 0], IRT: parentRef, RT: 'Group',
    });
    page.node.set(PDFName.of('Annots'), ctx.obj([parentRef, ctx.register(reply)]));
    return withKeys(await doc.save({ useObjectStreams: false }), keys);
  }

  const cases: [string, () => Promise<Uint8Array>][] = [
    ['/Contents (A) /C#6fntents (B) /Contents (C)', () => replyToParent(
      { QQQQQQQQ: 'A', CZZZntents: 'B', WWWWWWWW: 'C' },
      [['/QQQQQQQQ', '/Contents'], ['/CZZZntents', '/C#6fntents'], ['/WWWWWWWW', '/Contents']])],
    ['/Contents (A) /C#6fntents (B)', () => replyToParent(
      { QQQQQQQQ: 'A', CZZZntents: 'B' },
      [['/QQQQQQQQ', '/Contents'], ['/CZZZntents', '/C#6fntents']])],
  ];
  for (const [label, build] of cases) {
    it(`${label}: the reply is not imported, and stays one annotation through two commits`, async () => {
      const source = await build();
      const once = await commitCycle(source);
      expect((await subtypes(once)).sort()).toEqual(['Highlight', 'Text']);
      expect((await subtypes(await commitCycle(once))).sort()).toEqual(['Highlight', 'Text']);
      const { annotations, untouchedSlots } = await importFirstPage(source);
      expect(annotations).toHaveLength(0);
      expect([...untouchedSlots].sort()).toEqual([0, 1]);
    });
  }

  it('a reply to a parent that reads one way is imported as before', async () => {
    const source = await replyToParent({ QQQQQQQQ: 'A' }, [['/QQQQQQQQ', '/Contents']]);
    const { annotations, untouchedSlots } = await importFirstPage(source);
    expect(annotations.map((a) => a.note)).toEqual(['A', 'A']);
    expect(untouchedSlots).toEqual([]);
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
  it('decodes no key in a dictionary whose keys carry no escape, and only the escaped key once one does', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({ Type: 'Annot', Subtype: 'Ink', Rect: [0, 0, 1, 1], C: [0, 0, 1] });
    const decode = vi.spyOn(PDFName.prototype, 'asBytes');
    try {
      expect(entryOf(dict, 'BS')).toBeUndefined();
      expect(entryOf(dict, 'Border')).toBeUndefined();
      expect(decode).not.toHaveBeenCalled();
      dict.set(PDFName.of('B#6frder'), doc.context.obj([0, 0, 3]));
      // With an escaped key present every key is compared by its reading, and
      // only a key holding `#` is read from its bytes.
      expect(entryOf(dict, 'Border')).toBeInstanceOf(PDFArray);
      expect(decode).toHaveBeenCalledTimes(1);
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

const holdsHash = (name: PDFName): boolean => name.asString().includes('#');

const inkWith = (extra: (ctx: PDFContext) => Record<string, unknown>) => (ctx: PDFContext) => ctx.obj({
  Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], ...extra(ctx),
});

describe('names the parser left with a lowercase escape are rewritten at load (7.3.5)', () => {
  it('/B#6frder becomes /Border: the model, the saved bytes and pdf.js agree on width 3', async () => {
    const source = withKeys(await pageWith(inkWith(() => ({ BZZZrder: [0, 0, 3] }))), [['/BZZZrder', '/B#6frder']]);
    const doc = await PDFDocument.load(source);
    normalizeEscapedNames(doc, source, 'all');
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
    expect(names.some(holdsHash)).toBe(false);

    expect((await bothRects(source)).pdfjs).toEqual([94, 94, 156, 156]);
    // Read back without the load rewrite: the writer emitted /Border itself.
    const out = await commitUntouched(source);
    const saved = (await PDFDocument.load(out)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect(saved.get(PDFName.of('Border'))).toBeInstanceOf(PDFArray);
    expect(saved.keys().some(holdsHash)).toBe(false);
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
    expect(annot.keys().some(holdsHash)).toBe(false);
  });

  it('a file that wrote #23 before a lowercase pair keeps it: /#234fC is not /OC, as pdf.js reads it', async () => {
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
    expect(annot.get(PDFName.of('OC'))).toBeUndefined();
  });

  it('a plain document gains no new name', async () => {
    const plain = await pageWith(inkWith(() => ({ BS: { W: 3 } })));
    const doc = await PDFDocument.load(plain);
    const created = vi.spyOn(PDFName, 'of');
    try {
      normalizeEscapedNames(doc, plain, 'all');
      expect(created).not.toHaveBeenCalled();
    } finally {
      created.mockRestore();
    }
  });

  it('keeps a # the file wrote as #23 and rewrites only the lowercase escape after it', async () => {
    const source = withKeys(await pageWith(inkWith(() => ({ BZZZZZZZZx: 1 }))), [['/BZZZZZZZZx', '/B#2353#6fx']]);
    const doc = await PDFDocument.load(source);
    normalizeEscapedNames(doc, source, 'all');
    const annot = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    const keys = annot.keys().map((key) => Buffer.from(key.asBytes()).toString('latin1'));
    expect(keys).toContain('B#53ox');
  });
});

describe('an annotation whose reading the parse has lost is left untouched', () => {
  const cases: [string, () => Promise<Uint8Array>][] = [
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

describe('names settled by the tokens the file wrote (7.3.5)', () => {
  it('an image keyed /Im#236f1 and drawn as /Im#236f1 still draws after a field is added', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const image = ctx.register(ctx.stream(new Uint8Array([255, 0, 0]), {
      Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: 'DeviceRGB',
    }));
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { ImQQQQQ1: image } }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('q 100 0 0 100 0 0 cm /ImQQQQQ1 Do Q')));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/ImQQQQQ1', '/Im#236f1']]);
    const draws = async (bytes: Uint8Array): Promise<boolean> => {
      const pdf = await loadPdf(bytes);
      const ops = await (await pdf.getPage(1)).getOperatorList();
      await pdf.loadingTask.destroy();
      return ops.fnArray.includes(pdfjs.OPS.paintImageXObject);
    };
    expect(await draws(source)).toBe(true);
    const saved = await addFormFields(source, [{ name: 'notes', type: 'text', pageIndex: 0, rect: [150, 300, 250, 330] }]);
    expect(await draws(saved)).toBe(true);
  });

  it('a file holding both /B#6frder and /B#236frder leaves both, and imports neither', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const ink = (key: string) => ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], [key]: [0, 0, 3],
    }));
    page.node.set(PDFName.of('Annots'), ctx.obj([ink('BZZZrder'), ink('BQQQQQrder')]));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/BZZZrder', '/B#6frder'], ['/BQQQQQrder', '/B#236frder']]);
    const loaded = await PDFDocument.load(source);
    normalizeEscapedNames(loaded, source, 'all');
    const annots = loaded.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    for (let i = 0; i < 2; i++) {
      const keys = annots.lookup(i, PDFDict).keys().map((key) => Buffer.from(key.asBytes()).toString('latin1'));
      expect(keys).toContain('B#6frder');
      expect(keys).not.toContain('Border');
    }
    expect(await importAll(source)).toHaveLength(0);
  });

  it('a destination named by an indirect name object resolves after a rotation commit', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    doc.catalog.set(PDFName.of('Dests'), ctx.obj({ GZZZ: [page.ref, PDFName.of('Fit')] }));
    const outlines = ctx.nextRef();
    const item = ctx.register(ctx.obj({ Title: PDFString.of('Go there'), Parent: outlines, Dest: ctx.register(PDFName.of('GZZZ')) }));
    ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }));
    doc.catalog.set(PDFName.of('Outlines'), outlines);
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/GZZZ', '/G#6f']]);
    const out = await commitCycle(source, (p) => ({ ...p, rotation: 90 }));
    const pdf = await loadPdf(out);
    const [entry] = (await pdf.getOutline()) as { dest: string | unknown[] }[];
    const dest = typeof entry.dest === 'string' ? await pdf.getDestination(entry.dest) : entry.dest;
    await pdf.loadingTask.destroy();
    expect(Array.isArray(dest)).toBe(true);
  });

  it('a name ending in # and one hex digit reads the same on both sides and imports', async () => {
    const byReference = withKeys(await pageWith(inkWith(() => ({ RevZZ: 1 }))), [['/RevZZ', '/Rev#1']]);
    expect(await importAll(byReference)).toHaveLength(1);
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    page.node.set(PDFName.of('Annots'), doc.context.obj([inkWith(() => ({ RevZZ: 1 }))(doc.context)]));
    const direct = withKeys(await doc.save({ useObjectStreams: false }), [['/RevZZ', '/Rev#1']]);
    expect(await importAll(direct)).toHaveLength(1);
  });

  it('a signed append still pairs the page: /F#6f1 is rewritten to /Fo1, the name qpdf reads in the original', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { FQQQ1: font } }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /FQQQ1 12 Tf 20 300 Td (Hello) Tj ET')));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/FQQQ1', '/F#6f1']]);
    const modified = await commitCycle(source, (p) => ({
      ...p, annotations: [{ id: 'h', kind: 'highlight', x: 0.1, y: 0.1, w: 0.2, h: 0.05, color: '#ffd54a' }],
    }));
    const directory = mkdtempSync(join(tmpdir(), 'spectra-fingerprint-'));
    try {
      const originalPath = join(directory, 'original.pdf');
      const modifiedPath = join(directory, 'modified.pdf');
      writeFileSync(originalPath, source);
      writeFileSync(modifiedPath, modified);
      const plan = JSON.parse(execFileSync(testPython(), ['-B', '-c',
        'import json,sys,pikepdf; from engine.incremental import _plan_pages; '
          + 'o = pikepdf.open(sys.argv[1]); m = pikepdf.open(sys.argv[2]); p = _plan_pages(o, m); '
          + 'print(json.dumps({"pairs": p["pairs"], "fonts": sorted(str(k) for k in m.pages[0].Resources.Font.keys())}))',
        originalPath, modifiedPath],
      { env: { ...process.env, PYTHONPATH: resolve('src'), PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 15_000 })) as { pairs: number[][]; fonts: string[] };
      expect(plan.fonts).toEqual(['/Fo1']);
      expect(plan.pairs).toEqual([[0, 0]]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('an annotation the import left untouched is never stripped', () => {
  /** A and B share /Rect and /Contents; A draws inside the rectangle, B far
   *  outside it. */
  async function pair(b: (ctx: PDFContext) => Record<string, unknown>, keys: [string, string][] = []): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const ink = (inkList: number[], extra: Record<string, unknown>) => {
      const dict = ctx.obj({ Type: 'Annot', Subtype: 'Ink', InkList: [inkList], Rect: [10, 10, 20, 20], C: [0, 0, 1], ...extra });
      dict.set(PDFName.of('Contents'), PDFHexString.fromText('same'));
      return ctx.register(dict);
    };
    page.node.set(PDFName.of('Annots'), ctx.obj([ink([12, 12, 18, 18], { AP: appearance(ctx) }), ink([100, 100, 150, 150], b(ctx))]));
    return withKeys(await doc.save({ useObjectStreams: false }), keys);
  }

  const inkLists = async (bytes: Uint8Array): Promise<number[][]> => {
    const loaded = await PDFDocument.load(bytes);
    const annots = loaded.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    return annots.asArray().map((ref) => {
      const list = loaded.context.lookup(ref, PDFDict).lookup(PDFName.of('InkList'), PDFArray).lookup(0, PDFArray);
      return list.asArray().map((n) => Number(n.toString()));
    });
  };

  it('B left untouched by its unresolved names keeps its stroke while A is re-authored once', async () => {
    const source = await pair((ctx) => ({
      AS: 'ZZZZZ',
      AP: ctx.obj({ N: ctx.obj({ YYYYY: ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] })) }) }),
    }), [['/ZZZZZ', '/#6#41'], ['/YYYYY', '/#236A']]);
    const { annotations, untouchedSlots } = await importFirstPage(source);
    expect(annotations).toHaveLength(1);
    expect(untouchedSlots).toEqual([1]);
    const out = await commitCycle(source);
    expect(await subtypes(out)).toEqual(['Ink', 'Ink']);
    expect(await inkLists(out)).toContainEqual([100, 100, 150, 150]);
  });

  it('a slot left untouched is not stripped under a fingerprint it fits', async () => {
    // B fits A's fingerprint exactly; only its slot keeps it, as for an
    // annotation the rectangle cross-check refused.
    const source = await pair((ctx) => ({ AP: appearance(ctx) }));
    const out = await commitCycle(source, (p) => ({ ...p, annotations: p.annotations!.slice(0, 1), untouchedAnnotationSlots: [1] }));
    expect(await subtypes(out)).toEqual(['Ink', 'Ink']);
    expect(await inkLists(out)).toContainEqual([100, 100, 150, 150]);
  });

  it('deleting A strips A only, and B stays', async () => {
    const source = await pair((ctx) => ({ AP: appearance(ctx) }));
    const out = await commitCycle(source, (p) => ({
      ...p, annotations: [], removedImportedOriginals: [p.annotations![0].importedOriginal!], untouchedAnnotationSlots: [1],
    }));
    expect(await inkLists(out)).toEqual([[100, 100, 150, 150]]);
  });
});

/** A one-page file whose page /Resources live in a compressed object stream,
 *  written by hand: pdf-lib writes every `#` of a name as `#23`. */
function objectStreamPdf(resources: string, content: string, pad = ''): Uint8Array {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (bytes: Buffer): void => { parts.push(bytes); length += bytes.length; };
  const object = (n: number, body: Buffer): void => {
    offsets[n] = length;
    push(Buffer.concat([Buffer.from(`${n} 0 obj\n`), body, Buffer.from('\nendobj\n')]));
  };
  const stream = (dict: string, data: Buffer): Buffer =>
    Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
  push(Buffer.from('%PDF-1.7\n'));
  object(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  object(3, Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources 4 0 R /Contents 6 0 R >>'));
  object(5, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  object(6, stream('/Filter /FlateDecode', deflateSync(Buffer.from(content, 'latin1'))));
  const header = '4 0 ';
  object(7, stream(`${pad}/Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode`, deflateSync(Buffer.from(header + resources, 'latin1'))));
  const rows = [[0, 0, 65535], [1, offsets[1], 0], [1, offsets[2], 0], [1, offsets[3], 0], [2, 7, 0],
    [1, offsets[5], 0], [1, offsets[6], 0], [1, offsets[7], 0], [1, length, 0]];
  const table = Buffer.alloc(rows.length * 7);
  rows.forEach(([type, field, gen], i) => {
    table.writeUInt8(type, i * 7);
    table.writeUInt32BE(field, i * 7 + 1);
    table.writeUInt16BE(gen, i * 7 + 5);
  });
  const xrefAt = length;
  object(8, stream('/Type /XRef /Size 9 /W [1 4 2] /Root 1 0 R', table));
  push(Buffer.from(`startxref\n${xrefAt}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

describe('evidence read from object streams and indirect values', () => {
  it('a key inside a compressed object stream is settled: /F#6f1 becomes /Fo1, /G#236f1 stays', async () => {
    const bytes = objectStreamPdf('<< /Font << /F#6f1 5 0 R /G#236f1 5 0 R >> >>', 'BT /F#6f1 12 Tf 20 300 Td (Hi) Tj ET');
    const doc = await PDFDocument.load(bytes);
    normalizeEscapedNames(doc, bytes, 'all');
    const fonts = doc.getPage(0).node.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
    expect(fonts.keys().map((key) => Buffer.from(key.asBytes()).toString('latin1')).sort()).toEqual(['Fo1', 'G#6f1']);
  });

  it('a document whose only escaped names carry spaces reads no evidence', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([300, 400]);
    const ctx = source.context;
    page.node.set(PDFName.of('Resources'), ctx.obj({
      Font: { F1: ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: PDFName.of('Times New Roman') })) },
    }));
    const bytes = await source.save();
    expect(Buffer.from(bytes).toString('latin1')).toContain('ObjStm');
    const doc = await PDFDocument.load(bytes);
    const parse = vi.spyOn(PDFObjectParser, 'forBytes');
    try {
      normalizeEscapedNames(doc, bytes, 'all');
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('an /AS held by reference is settled for the sidecar as the build settles it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1],
      AS: ctx.register(PDFName.of('OQQQ')),
      AP: ctx.obj({ N: ctx.obj({ On: ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] })) }) }),
    }))]));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/OQQQ', '/O#6e']]);
    const { pdfjs: theirs } = await bothRects(source);
    expect(theirs).toEqual([10, 10, 20, 20]);
    expect(await importAll(source)).toHaveLength(1);
    const once = await commitCycle(source);
    expect(await subtypes(once)).toEqual(['Ink']);
    expect(await subtypes(await commitCycle(once))).toEqual(['Ink']);
  });
});

describe('an annotation value that refers to itself', () => {
  it('a self-referencing /LE array beside an escaped key settles without failing, and the sidecar records the Ink', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const le = ctx.nextRef();
    ctx.assign(le, ctx.obj([le]));
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], LE: le, BZZZrder: [0, 0, 3],
    }))]));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/BZZZrder', '/B#6frder']]);
    const loaded = await PDFDocument.load(source);
    expect(() => normalizeEscapedNames(loaded, source, 'annotations')).not.toThrow();
    const annot = loaded.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect(annot.get(PDFName.of('Border'))).toBeInstanceOf(PDFArray);
    expect(annot.keys().some(holdsHash)).toBe(false);
    const styles = await readRawAnnotationStyles(source);
    expect(styles?.[0].map((style) => style.subtype)).toEqual(['Ink']);
  });

  it('an /LE array of 1000 references to itself, with no escaped name, is probed in a linear number of lookups and reads no evidence', async () => {
    const count = 1000;
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const le = ctx.nextRef();
    ctx.assign(le, ctx.obj(Array.from({ length: count }, () => le)));
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], LE: le,
    }))]));
    const source = await doc.save({ useObjectStreams: false });
    expect(Buffer.from(source).includes('#')).toBe(false);
    const loaded = await PDFDocument.load(source);
    expect(loaded.context.lookup(le, PDFArray).size()).toBe(count);

    const context = loaded.context;
    const lookup = context.lookup.bind(context) as (ref: unknown) => unknown;
    const bound = 4 * count;
    let lookups = 0;
    (context as unknown as { lookup: (ref: unknown) => unknown }).lookup = (ref) => {
      lookups += 1;
      if (lookups > bound) throw new Error(`more than ${bound} lookups`);
      return lookup(ref);
    };
    const scan = vi.spyOn(source, 'indexOf');
    const parse = vi.spyOn(PDFObjectParser, 'forBytes');
    try {
      expect(() => normalizeEscapedNames(loaded, source, 'annotations')).not.toThrow();
      expect(lookups).toBeLessThanOrEqual(bound);
      expect(scan).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
      parse.mockRestore();
      delete (context as unknown as { lookup?: unknown }).lookup;
    }
  });

  it('two /LE arrays that hold each other beside an escaped key settle without failing, and the sidecar records the Ink', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const first = ctx.nextRef();
    const second = ctx.nextRef();
    ctx.assign(first, ctx.obj([second]));
    ctx.assign(second, ctx.obj([first]));
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], LE: first, BZZZrder: [0, 0, 3],
    }))]));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/BZZZrder', '/B#6frder']]);
    const loaded = await PDFDocument.load(source);
    expect(() => normalizeEscapedNames(loaded, source, 'annotations')).not.toThrow();
    const annot = loaded.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect(annot.get(PDFName.of('Border'))).toBeInstanceOf(PDFArray);
    const styles = await readRawAnnotationStyles(source);
    expect(styles?.[0].map((style) => style.subtype)).toEqual(['Ink']);
  });
});

describe('an indirect value reached more than once', () => {
  const line = (ctx: PDFContext, extra: Record<string, unknown>): PDFDict => ctx.obj({
    Type: 'Annot', Subtype: 'Line', L: [40, 100, 160, 140], Rect: [36, 96, 164, 144], C: [0, 0, 0], ...extra,
  });

  it('two annotations sharing one /LE array of an indirect escaped name both read the settled name', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const ending = ctx.register(PDFName.of('OpZZZnArrow'));
    const le = ctx.register(ctx.obj([ending, ending]));
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(line(ctx, { LE: le })), ctx.register(line(ctx, { LE: le }))]));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/OpZZZnArrow', '/Op#65nArrow']]);
    const loaded = await PDFDocument.load(source);
    normalizeEscapedNames(loaded, source, 'annotations');
    const annots = loaded.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    for (const slot of [0, 1]) {
      const endings = annots.lookup(slot, PDFDict).lookup(PDFName.of('LE'), PDFArray);
      expect([endings.lookup(0), endings.lookup(1)]).toEqual([PDFName.of('OpenArrow'), PDFName.of('OpenArrow')]);
    }
    const styles = await readRawAnnotationStyles(source);
    expect(styles?.[0].map((style) => style.subtype)).toEqual(['Line', 'Line']);
  });

  it('a reference met first below the probe depth and then within it still triggers the evidence read', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const le = ctx.register(ctx.obj([PDFName.of('OpZZZnArrow'), PDFName.of('None')]));
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(line(ctx, { Deep: [[[le]]], LE: le }))]));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [['/OpZZZnArrow', '/Op#65nArrow']]);
    const loaded = await PDFDocument.load(source);
    const annot = loaded.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect(annot.keys().map((key) => key.asString())).toEqual(expect.arrayContaining(['/Deep', '/LE']));
    expect(annot.keys().findIndex((key) => key === PDFName.of('Deep'))).toBeLessThan(annot.keys().findIndex((key) => key === PDFName.of('LE')));
    normalizeEscapedNames(loaded, source, 'annotations');
    expect(annot.lookup(PDFName.of('LE'), PDFArray).lookup(0)).toBe(PDFName.of('OpenArrow'));
  });
});

describe('a name token of any length is evidence', () => {
  it('an image keyed by a 603-byte name ending in #6a still draws after a field is added', async () => {
    const placeholder = `I${'a'.repeat(599)}ZZZ`;
    const written = `I${'a'.repeat(599)}#6a`;
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const image = ctx.register(ctx.stream(new Uint8Array([255, 0, 0]), {
      Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: 'DeviceRGB',
    }));
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { [placeholder]: image } }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(`q 100 0 0 100 0 0 cm /${placeholder} Do Q`)));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [[`/${placeholder}`, `/${written}`]]);
    const draws = async (bytes: Uint8Array): Promise<boolean> => {
      const pdf = await loadPdf(bytes);
      const ops = await (await pdf.getPage(1)).getOperatorList();
      await pdf.loadingTask.destroy();
      return ops.fnArray.includes(pdfjs.OPS.paintImageXObject);
    };
    expect(await draws(source)).toBe(true);
    const loaded = await PDFDocument.load(source);
    normalizeEscapedNames(loaded, source, 'all');
    const xobjects = loaded.getPage(0).node.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict);
    expect(xobjects.keys().map((key) => key.asString())).toEqual([`/I${'a'.repeat(599)}j`]);
    const saved = await addFormFields(source, [{ name: 'notes', type: 'text', pageIndex: 0, rect: [150, 300, 250, 330] }]);
    expect(await draws(saved)).toBe(true);
  });

  it('a # after 2000 regular bytes and before 2000 more yields the whole token', () => {
    const token = `${'a'.repeat(2000)}#6a${'b'.repeat(2000)}`;
    const tokens = new Set<string>();
    scanNameTokens(new Uint8Array(Buffer.from(`<< /${token} 1 >>`, 'latin1')), tokens);
    expect([...tokens]).toEqual([token]);
  });

  it('an object stream whose /Type is 5000 bytes after its obj keyword is read: /F#6f1 becomes /Fo1', async () => {
    const bytes = objectStreamPdf('<< /Font << /F#6f1 5 0 R >> >>', 'BT /F#6f1 12 Tf 20 300 Td (Hi) Tj ET', `/Pad (${'x'.repeat(5000)}) `);
    const doc = await PDFDocument.load(bytes);
    normalizeEscapedNames(doc, bytes, 'all');
    const fonts = doc.getPage(0).node.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
    expect(fonts.keys().map((key) => key.asString())).toEqual(['/Fo1']);
  });

  it('an image keyed by a name of 3 MB ending in #6a is settled in slices, and still draws after a field is added', async () => {
    const run = 3 * 1024 * 1024;
    const placeholder = `I${'a'.repeat(run)}ZZZ`;
    const written = `I${'a'.repeat(run)}#6a`;
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const image = ctx.register(ctx.stream(new Uint8Array([255, 0, 0]), {
      Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: 'DeviceRGB',
    }));
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { [placeholder]: image } }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(`q 100 0 0 100 0 0 cm /${placeholder} Do Q`)));
    const source = withKeys(await doc.save({ useObjectStreams: false }), [[`/${placeholder}`, `/${written}`]]);
    const draws = async (bytes: Uint8Array): Promise<boolean> => {
      const pdf = await loadPdf(bytes);
      const ops = await (await pdf.getPage(1)).getOperatorList();
      await pdf.loadingTask.destroy();
      return ops.fnArray.includes(pdfjs.OPS.paintImageXObject);
    };
    const loaded = await PDFDocument.load(source);
    // Each string the normaliser builds from bytes goes through
    // String.fromCharCode: once per slice of 8192, never once per byte.
    const built = vi.spyOn(String, 'fromCharCode');
    let calls: number;
    try {
      normalizeEscapedNames(loaded, source, 'all');
      calls = built.mock.calls.length;
    } finally {
      built.mockRestore();
    }
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(4 * Math.ceil(written.length / 8192) + 16);
    const xobjects = loaded.getPage(0).node.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict);
    const [key] = xobjects.keys();
    expect(xobjects.keys()).toHaveLength(1);
    expect(key.asString() === `/I${'a'.repeat(run)}j`).toBe(true);
    const saved = await addFormFields(source, [{ name: 'notes', type: 'text', pageIndex: 0, rect: [150, 300, 250, 330] }]);
    const again = (await PDFDocument.load(saved)).getPage(0).node.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict);
    expect(again.keys()).toEqual([key]);
    expect(await draws(saved)).toBe(true);
  }, 120_000);
});

describe('the pdf.js reading of a name token, built by slices', () => {
  /** One character at a time: the reading the sliced form must equal. */
  const perCharacter = (raw: string): string => {
    const hex = (code: number): number => {
      if (code >= 0x30 && code <= 0x39) return code - 0x30;
      if (code >= 0x41 && code <= 0x46) return code - 0x37;
      if (code >= 0x61 && code <= 0x66) return code - 0x57;
      return -1;
    };
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) !== 0x23) {
        out += raw[i];
        continue;
      }
      if (i + 1 >= raw.length) {
        out += '#';
        break;
      }
      const high = hex(raw.charCodeAt(i + 1));
      if (high === -1) {
        out += '#' + raw[i + 1];
        i += 1;
        continue;
      }
      if (i + 2 >= raw.length) {
        out += '#' + raw[i + 1];
        break;
      }
      const low = hex(raw.charCodeAt(i + 2));
      if (low === -1) {
        out += '#' + raw[i + 1] + raw[i + 2];
        i += 2;
        continue;
      }
      out += String.fromCharCode((high << 4) | low);
      i += 2;
    }
    return out;
  };

  const edges = [
    '', 'abc', '#', 'a#', '##', '###', '#4', 'a#4', '#g', '#g1', '#gg', '#4g', '#4g41', '#4#41', '##41', '#g#41',
    '#41', '#6f', '#6F', '#aB', '#Ab', '#ff', '#FF', '#00', 'a#00b', '#23', '#2341', '#23#41', '#41#42#43', '#41#4',
    '#41#', '#41#g', 'a#41b#6fc', '#4#4#41', '#4g#41', '\u00e9#e9', 'Name#20With#20Spaces',
  ];
  for (const raw of edges) {
    it(`${JSON.stringify(raw)} reads as the per-character form reads it`, () => {
      expect(pdfjsNameReading(raw)).toBe(perCharacter(raw));
    });
  }

  it('a run of 20,000 characters reads the same with an escape, or a # that starts none, at each slice boundary', () => {
    for (const at of [8189, 8190, 8191, 8192, 8193, 8194, 16383, 16384, 16385]) {
      for (const piece of ['#6a', '#6A', '#00', '#4g', '#g1', '##', '#41#42', '#4#41']) {
        const raw = `${'a'.repeat(at)}${piece}${'b'.repeat(20000 - at - piece.length)}`;
        expect(raw).toHaveLength(20000);
        expect(pdfjsNameReading(raw) === perCharacter(raw)).toBe(true);
      }
    }
    const every = `${'a'.repeat(8191)}#6a#6b#6c${'b'.repeat(8180)}#4${'c'.repeat(3617)}#`;
    expect(every).toHaveLength(20000);
    expect(pdfjsNameReading(every) === perCharacter(every)).toBe(true);
  });

  it('5000 generated tokens over # and hex and non-hex characters read the same', () => {
    const alphabet = ['#', '#', '4', '6', 'a', 'F', 'g', 'Z', '0'];
    let seed = 0x2f6e2b1;
    const next = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let n = 0; n < 5000; n++) {
      let raw = '';
      const length = (next() >>> 8) % 14;
      for (let i = 0; i < length; i++) raw += alphabet[(next() >>> 8) % alphabet.length];
      expect(pdfjsNameReading(raw), JSON.stringify(raw)).toBe(perCharacter(raw));
    }
  });
});

describe('a key whose rewrite would meet another key of its dictionary', () => {
  const collision = async (borders: Record<string, unknown>): Promise<Uint8Array> => withKeys(
    await pageWith(inkWith(() => ({ ...borders, CZZZ: true, DZZZ: 'EZZZ' }))),
    [['/BZZZrder', '/B#6frder'], ['/CZZZ', '/C#6f'], ['/DZZZ', '/D#6f'], ['/EZZZ', '/E#6f']]);
  const cases: [string, Record<string, unknown>, number][] = [
    ['plain then escaped', { Border: [0, 0, 1], BZZZrder: [0, 0, 3] }, 3],
    ['escaped then plain', { BZZZrder: [0, 0, 3], Border: [0, 0, 1] }, 1],
  ];
  for (const [label, borders, width] of cases) {
    it(`${label}: the other names of the dictionary are settled, and the two keys keep their order`, async () => {
      const source = await collision(borders);
      const doc = await PDFDocument.load(source);
      normalizeEscapedNames(doc, source, 'all');
      const annot = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
      expect(annot.get(PDFName.of('Co'))).toBeDefined();
      expect(annot.get(PDFName.of('Do'))).toBe(PDFName.of('Eo'));
      const written = annot.keys().map((key) => key.asString());
      expect(written.filter((key) => key.includes('#'))).toEqual(['/B#6frder']);
      expect(written.indexOf('/Border') < written.indexOf('/B#6frder')).toBe(width === 3);
      expect(await importAll(source)).toHaveLength(0);
    });

    it(`${label}: a commit leaves the width pdf.js reads at ${width}`, async () => {
      const source = await collision(borders);
      const box = [100 - 2 * width, 100 - 2 * width, 150 + 2 * width, 150 + 2 * width];
      expect((await bothRects(source)).pdfjs).toEqual(box);
      const once = await commitUntouched(source);
      expect((await bothRects(once)).pdfjs).toEqual(box);
      const twice = await commitCycle(once);
      expect(await subtypes(twice)).toEqual(['Ink']);
      expect((await bothRects(twice)).pdfjs).toEqual(box);
    });
  }

  it('two escaped keys with one reading are both kept as written', async () => {
    const source = withKeys(
      await pageWith(inkWith(() => ({ CZZZntents: PDFString.of('first'), CoZZZtents: PDFString.of('second') }))),
      [['/CZZZntents', '/C#6fntents'], ['/CoZZZtents', '/Co#6etents']]);
    const doc = await PDFDocument.load(source);
    normalizeEscapedNames(doc, source, 'all');
    const annot = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect(annot.keys().map((key) => key.asString()).filter((key) => key.includes('#'))).toEqual(['/C#6fntents', '/Co#6etents']);
    const contents = async (bytes: Uint8Array): Promise<string | undefined> => {
      const pdf = await loadPdf(bytes);
      const [read] = (await (await pdf.getPage(1)).getAnnotations()) as { contentsObj?: { str?: string } }[];
      await pdf.loadingTask.destroy();
      return read.contentsObj?.str;
    };
    expect(await contents(source)).toBe('second');
    expect(await contents(await commitUntouched(source))).toBe('second');
  });

  /** Two Inks on one page, each with /Border beside /B#6frder. */
  const twoCollisions = async (): Promise<Uint8Array> => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ink = inkWith(() => ({ Border: [0, 0, 1], BZZZrder: [0, 0, 3] }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(ink(doc.context)), doc.context.register(ink(doc.context))]));
    return withKeys(await doc.save({ useObjectStreams: false }), [['/BZZZrder', '/B#6frder']]);
  };
  const heldBack = (doc: PDFDocument, slot: number): { dict: PDFDict; key: PDFName } => {
    const dict = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(slot, PDFDict);
    const keys = dict.keys().filter((key) => key.asString() === '/B#6frder');
    expect(keys).toHaveLength(1);
    return { dict, key: keys[0] };
  };

  it('one token is one key object within a document, and another object in each other document', async () => {
    const source = await twoCollisions();
    const first = await PDFDocument.load(source);
    normalizeEscapedNames(first, source, 'all');
    expect(heldBack(first, 0).key).toBe(heldBack(first, 1).key);
    const second = await PDFDocument.load(source);
    normalizeEscapedNames(second, source, 'all');
    expect(heldBack(second, 0).key).toBe(heldBack(second, 1).key);
    expect(heldBack(second, 0).key).not.toBe(heldBack(first, 0).key);
  });

  it('a held-back key copied into a second document is the same object there and is written as the token of the file', async () => {
    const source = await twoCollisions();
    const from = await PDFDocument.load(source);
    normalizeEscapedNames(from, source, 'all');
    const { key } = heldBack(from, 0);
    const out = await PDFDocument.create();
    const [page] = await out.copyPages(from, [0]);
    out.addPage(page);
    for (const slot of [0, 1]) {
      const copy = heldBack(out, slot);
      expect(copy.key).toBe(key);
      expect(copy.dict.get(key)).toBeInstanceOf(PDFArray);
      expect(copy.dict.get(PDFName.of('Border'))).toBeInstanceOf(PDFArray);
    }
    expect(nameReading(key, out.context)).toBe('B#6frder');
    expect(nameIsUnresolved(key, out.context)).toBe(true);
    const saved = Buffer.from(await out.save({ useObjectStreams: false })).toString('latin1');
    expect(saved.split('/B#6frder').length - 1).toBe(2);
    expect(saved).not.toContain('#23');
    const pdf = await loadPdf(new Uint8Array(Buffer.from(saved, 'latin1')));
    const annots = (await (await pdf.getPage(1)).getAnnotations()) as { borderStyle: { width: number } }[];
    await pdf.loadingTask.destroy();
    expect(annots.map((annot) => annot.borderStyle.width)).toEqual([3, 3]);
  });
});

describe('a name unresolved in one source document', () => {
  it('does not keep the commit from replacing an annotation of another source that wrote the same spelling one way', async () => {
    // a.pdf writes /K#236f only, which reads K#6f on both sides. b.pdf
    // writes /K#6f and /K#236f, so K#6f is unresolved there.
    const a = withKeys(await pageWith(inkWith(() => ({ KQQQQQ: true }))), [['/KQQQQQ', '/K#236f']]);
    const other = await PDFDocument.create();
    const otherPage = other.addPage([300, 400]);
    const ink = (key: string) => other.context.register(other.context.obj({
      Type: 'Annot', Subtype: 'Ink', InkList: [[100, 100, 150, 150]], Rect: [10, 10, 20, 20], C: [0, 0, 1], [key]: true,
    }));
    otherPage.node.set(PDFName.of('Annots'), other.context.obj([ink('KZZZ'), ink('KQQQQQ')]));
    const b = withKeys(await other.save({ useObjectStreams: false }), [['/KZZZ', '/K#6f'], ['/KQQQQQ', '/K#236f']]);

    const fromA = await importFirstPage(a);
    expect(fromA.annotations).toHaveLength(1);
    expect(fromA.untouchedSlots).toEqual([]);
    const fromB = await importFirstPage(b);
    expect(fromB.annotations).toHaveLength(0);
    expect([...fromB.untouchedSlots].sort()).toEqual([0, 1]);

    const files = new Map([['a.pdf', makeFile('a.pdf', a)], ['b.pdf', makeFile('b.pdf', b)]]);
    const own: PageRef = { id: 'a.pdf#p0', sourceDocId: 'a.pdf', sourcePageIndex: 0, rotation: 0, width: 0, height: 0,
      annotations: fromA.annotations };
    const inserted: PageRef = { id: 'b.pdf#p0', sourceDocId: 'b.pdf', sourcePageIndex: 0, rotation: 0, width: 0, height: 0,
      untouchedAnnotationSlots: fromB.untouchedSlots };
    const doc: OpenDocument = { ...files.get('a.pdf')!, id: 'a.pdf#0', pages: [own, inserted], pageCount: 2 };
    const [plan] = planCommit({ documents: [doc] }, files, ['a.pdf']);
    const out = await loadPdf(await buildCommitBytes(plan));
    const counts: number[] = [];
    for (let i = 1; i <= out.numPages; i++) counts.push(((await (await out.getPage(i)).getAnnotations()) as unknown[]).length);
    await out.loadingTask.destroy();
    expect(counts).toEqual([1, 2]);
  });
});
