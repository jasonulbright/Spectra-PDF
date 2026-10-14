import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFObject, PDFRef, PDFString, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { importPageAnnotations } from '../src/renderer/lib/annotation-import';
import { planCommit, buildCommitBytes } from '../src/renderer/lib/workspace-commit';
import { pdfNameText } from '../src/renderer/lib/pdf-text-string';
import type { OpenDocument, OpenFile, PageAnnotation, PageRef, Workspace } from '../src/renderer/state/types';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return (await pdfjs.getDocument({ data: bytes.slice() }).promise) as PDFDocumentProxy;
}

/** The print-preflight fixture's construction: an image XObject, a raw
 *  content stream, and a /Text annotation whose /Contents is written through
 *  `ctx.obj`, which turns a JS string into a name object. */
async function buildPreflightShapedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const image = ctx.stream(new Uint8Array(10 * 10 * 3).fill(0x40), {
    Type: 'XObject', Subtype: 'Image', Width: 10, Height: 10, BitsPerComponent: 8, ColorSpace: 'DeviceRGB',
  });
  page.node.setXObject(PDFName.of('Im0'), ctx.register(image));
  page.drawText('Preflight fixture', { x: 40, y: 700, size: 14, font });
  page.drawRectangle({ x: 40, y: 640, width: 200, height: 20, color: undefined });
  page.node.addContentStream(ctx.register(ctx.stream([
    '1 0 0 rg 40 600 200 20 re f',
    '0.05 w 0 0 0 RG 40 560 m 400 560 l S',
    'q 100 0 0 100 40 400 cm /Im0 Do Q',
  ].join('\n'))));
  const annot = ctx.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [500, 700, 520, 720], F: 4,
    Contents: 'Check this before it goes out',
  });
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
  return doc.save();
}

function makeFile(path: string, buffer: Uint8Array): OpenFile {
  return { path, workingPath: `${path}.working`, name: path, pageCount: 1, buffer, dirty: false, undoStack: [], redoStack: [] };
}

function pageRef(path: string): PageRef {
  return { id: `${path}#p0`, sourceDocId: path, sourcePageIndex: 0, rotation: 0, width: 0, height: 0 };
}

function makeDoc(id: string, file: OpenFile, pages: PageRef[]): OpenDocument {
  return { ...file, id, name: file.name, pages, pageCount: pages.length };
}

/** One import + commit cycle: every annotation the file holds is imported,
 *  `edit` may change them, and the page is rebuilt. */
async function commitCycle(
  bytes: Uint8Array,
  edit: (imported: PageAnnotation[]) => PageAnnotation[] = imported => imported,
): Promise<Uint8Array> {
  const pdf = await loadPdf(bytes);
  const imported = await importPageAnnotations(await pdf.getPage(1));
  await pdf.loadingTask.destroy();
  const file = makeFile('a.pdf', bytes);
  const workspace: Workspace = {
    documents: [makeDoc('a.pdf#0', file, [{ ...pageRef('a.pdf'), annotations: edit(imported) }])],
  };
  const [plan] = planCommit(workspace, new Map([['a.pdf', file]]), ['a.pdf']);
  return buildCommitBytes(plan);
}

const HIGHLIGHT: PageAnnotation = { id: 'h1', kind: 'highlight', x: 0.1, y: 0.1, w: 0.2, h: 0.05, color: '#ffd54a' };

async function commitWithHighlight(bytes: Uint8Array): Promise<Uint8Array> {
  return commitCycle(bytes, imported => [...imported, HIGHLIGHT]);
}

interface ReadAnnotation { subtype: string; contentsObj?: { str: string } }

/** The text of each /Contents of page 1 that the file writes as a name. */
async function nameTypedContents(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = doc.getPage(0).node.Annots()?.asArray() ?? [];
  return annots.flatMap((ref) => {
    const contents = doc.context.lookup(ref, PDFDict).get(PDFName.of('Contents'));
    return contents instanceof PDFName ? [pdfNameText(contents)] : [];
  });
}

async function readAnnotations(bytes: Uint8Array): Promise<ReadAnnotation[]> {
  const pdf = await loadPdf(bytes);
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as ReadAnnotation[];
  await pdf.loadingTask.destroy();
  return annots;
}

const hex = (codes: number[]): string => codes.map(c => c.toString(16).padStart(2, '0')).join('');
const literal = (codes: number[]): PDFString => PDFString.of(String.fromCharCode(...codes));

/** One /Square whose /Contents and /Rect are exactly what the caller gives. */
async function squareWith(contents: PDFObject, rect = [20, 300, 80, 320]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const ctx = doc.context;
  const square = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: rect, C: [1, 0, 0], F: 4 });
  square.set(PDFName.of('Contents'), contents);
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(square)]));
  return doc.save();
}

describe('page-tier commit over hand-built annotations', () => {
  it('commits a highlight on the preflight fixture', async () => {
    const out = await commitWithHighlight(await buildPreflightShapedPdf());
    const pdf = await loadPdf(out);
    const annots = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string }[];
    expect(annots.map(a => a.subtype).sort()).toEqual(['Highlight', 'Text']);
    await pdf.loadingTask.destroy();
  });

  it('keeps the text of a sticky note whose /Contents is a name', async () => {
    const once = await commitWithHighlight(await buildPreflightShapedPdf());
    expect(await nameTypedContents(once)).toEqual(['Check this before it goes out']);
    const twice = await commitCycle(once);
    expect(await nameTypedContents(twice)).toEqual(['Check this before it goes out']);
    expect((await readAnnotations(twice)).map(a => a.subtype).sort()).toEqual(['Highlight', 'Text']);
  });

  it('carries a name-typed /Contents with a lowercase escape as its text', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const note = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [20, 300, 40, 320], F: 4 });
    note.set(PDFName.of('Contents'), PDFName.of('caf#c3#a9'));
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(note)]));
    const unedited = await commitCycle(await doc.save());
    expect(await readAnnotations(unedited)).toHaveLength(1);
    expect(await nameTypedContents(unedited)).toEqual([`caf${String.fromCharCode(0xe9)}`]);
  });

  it('a note the user wrote outranks a name-typed /Contents', async () => {
    const out = await commitCycle(await buildPreflightShapedPdf(), imported => imported.map(a => ({ ...a, note: 'mine' })));
    const annots = await readAnnotations(out);
    expect(annots).toHaveLength(1);
    expect(annots[0].contentsObj?.str).toBe('mine');
  });

  // Each case: the import side's reading and the commit side's re-reading of
  // the file must agree, or every cycle leaves the original and adds a copy.
  const agreement: [string, () => Promise<Uint8Array>, string][] = [
    ['a UTF-8 text string with its byte order mark', () => squareWith(literal([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63])), 'abc'],
    ['a language escape sequence', () => squareWith(literal([0x1b, 0x65, 0x6e, 0x1b, 0x61, 0x62])), 'ab'],
    ['a reversed /Rect', () => squareWith(PDFHexString.fromText('reversed'), [80, 320, 20, 300]), 'reversed'],
    ['a UTF-16BE text string with its byte order mark', () => squareWith(PDFHexString.of(hex([0xfe, 0xff, 0x00, 0x61, 0x20, 0x22]))), 'a' + String.fromCharCode(0x2022)],
    ['a PDFDocEncoding bullet', () => squareWith(literal([0x80, 0x61])), String.fromCharCode(0x2022) + 'a'],
    ['an empty string', () => squareWith(literal([])), ''],
    ['bytes PDFDocEncoding leaves undefined', () => squareWith(literal([0x16, 0x7f, 0x9f, 0xad])), String.fromCharCode(0x16, 0x7f, 0x9f, 0xad)],
    ['a hex string', () => squareWith(PDFHexString.of(hex([0x48, 0x69]))), 'Hi'],
    ['a hex string with whitespace between digits', () => squareWith(PDFHexString.of('48 69')), 'Hi'],
    ['a literal line continuation', () => squareWith(PDFString.of(`a${String.fromCharCode(0x5c, 0x0d, 0x0a)}b`)), 'ab'],
    ['a three-digit octal escape above 255', () => squareWith(PDFString.of(`${String.fromCharCode(0x5c)}777`)), String.fromCharCode(0x1ff)],
    ['an odd UTF-16 run that fails to decode', () => squareWith(PDFHexString.of('FEFFD80041')), String.fromCharCode(0xfe, 0xff, 0xd8, 0x00)],
  ];
  for (const [label, build, text] of agreement) {
    it(`commits ${label} to exactly one annotation, cycle after cycle`, async () => {
      const once = await commitCycle(await build());
      const first = await readAnnotations(once);
      expect(first).toHaveLength(1);
      expect(first[0].contentsObj?.str ?? '').toBe(text);
      expect(await readAnnotations(await commitCycle(once))).toHaveLength(1);
    });
  }

  it('commits a highlight when /Annots holds a direct annotation without /P', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const note = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [20, 300, 40, 320], F: 4 });
    note.set(PDFName.of('Contents'), PDFHexString.fromText('direct note'));
    page.node.set(PDFName.of('Annots'), ctx.obj([note]));
    const out = await commitWithHighlight(await doc.save());
    const pdf = await loadPdf(out);
    const annots = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string; contentsObj?: { str: string } }[];
    expect(annots.map(a => a.subtype).sort()).toEqual(['Highlight', 'Text']);
    expect(annots.find(a => a.subtype === 'Text')?.contentsObj?.str).toBe('direct note');
    await pdf.loadingTask.destroy();
  });

  it('commits a highlight when /Annots names a missing object and a null', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const ctx = doc.context;
    const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [20, 300, 40, 320], F: 4 }));
    page.node.set(PDFName.of('Annots'), ctx.obj([PDFRef.of(9999), PDFNull, note]));
    const out = await commitWithHighlight(await doc.save());
    const pdf = await loadPdf(out);
    const annots = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string }[];
    expect(annots.map(a => a.subtype).sort()).toEqual(['Highlight', 'Text']);
    await pdf.loadingTask.destroy();
    // Both null entries stay in the rebuilt /Annots, in place: the missing
    // object as a reference that still resolves to nothing, the null as null.
    const rebuilt = await PDFDocument.load(out);
    const entries = rebuilt.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).asArray();
    expect(entries).toHaveLength(4);
    expect(entries[0]).toBeInstanceOf(PDFRef);
    expect(rebuilt.context.lookup(entries[0])).toBeUndefined();
    expect(entries[1]).toBe(PDFNull);
    const subtypes = entries.slice(2).map(e => rebuilt.context.lookup(e, PDFDict).get(PDFName.of('Subtype')));
    expect(subtypes).toEqual([PDFName.of('Text'), PDFName.of('Highlight')]);
  });
});
