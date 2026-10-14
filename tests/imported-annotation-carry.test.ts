// An annotation the file already holds goes through a page-tier commit as it
// is written when the user did not edit it: the same dictionary and the same
// appearance stream. An edited one keeps every entry the edit did not change
// and the model does not hold. ISO 32000-2 12.5.2 Table 166 (/NM, /M, /F,
// /AP, /Border, /OC), 12.5.6.2 Table 172 (/T, /Popup, /CA, /RC,
// /CreationDate, /IRT, /Subj, /RT, /IT), 12.5.6.6 Table 177 (/DA, /Q, /RC,
// /DS, /CL, /BS, /RD, /LE), 12.5.5 (the appearance box maps onto /Rect).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import { PDFContext } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { noteIconAppearance, recolouredContent } from '../src/renderer/lib/note-appearance';
import type { PageAnnotation, PageRef } from '../src/renderer/state/types';
import { rotateAnnotationRect } from '../src/renderer/state/reducer';
import { editIsNone, importedEdit } from '../src/renderer/lib/imported-edit';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit, deleting, importedPages } from './support/commit-cycle';
import { annotsOf, expectSound, latin1, loadPdf } from './support/saved-pdf';
import { testPython } from './support/python';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const N = PDFName.of;
const RUN = 60_000;

/** One annotation as a plain value: every entry, appearance streams decoded.
 *  A reference to another annotation or to the page reads as a label, so two
 *  files compare without their object numbers. */
function plain(doc: PDFDocument, value: PDFObject | undefined, trail: string[] = []): unknown {
  if (value instanceof PDFRef) {
    if (trail.includes(value.tag)) return '<cycle>';
    const target = doc.context.lookup(value);
    if (target instanceof PDFDict && target.lookup(N('Type')) === N('Page')) return '<page>';
    return plain(doc, target, [...trail, value.tag]);
  }
  if (value instanceof PDFStream) {
    const dict = plainDict(doc, value.dict, trail, new Set(['Length', 'Filter', 'DecodeParms']));
    const data = value instanceof PDFRawStream ? latin1(decodePDFRawStream(value).decode()) : latin1(value.getContents());
    return { stream: dict, data };
  }
  if (value instanceof PDFDict) return plainDict(doc, value, trail, new Set());
  if (value instanceof PDFArray) return value.asArray().map((entry) => plain(doc, entry, trail));
  if (value instanceof PDFNumber) return Math.round(value.asNumber() * 1000) / 1000;
  if (value instanceof PDFString || value instanceof PDFHexString) return `(${value.decodeText()})`;
  return value === undefined ? undefined : String(value);
}

const label = (doc: PDFDocument, value: PDFObject | undefined): string => {
  const target = doc.context.lookup(value);
  if (!(target instanceof PDFDict)) return '<none>';
  const name = target.lookup(N('NM'));
  const contents = target.lookup(N('Contents'));
  const text = (v: PDFObject | undefined) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '');
  return `<${String(target.lookup(N('Subtype')))} ${text(name)} ${text(contents)}>`;
};

function plainDict(doc: PDFDocument, dict: PDFDict, trail: string[], skip: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of dict.entries()) {
    const name = key.decodeText();
    if (skip.has(name)) continue;
    out[name] = name === 'Popup' || name === 'Parent' || name === 'IRT' ? label(doc, entry) : plain(doc, entry, trail);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function annotations(bytes: Uint8Array, pageIndex = 0): Promise<Record<string, unknown>[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return annotsOf(doc, pageIndex).map(({ dict }) => plainDict(doc, dict, [], new Set()));
}

const named = (list: Record<string, unknown>[], name: string): Record<string, unknown> => {
  const found = list.filter((entry) => entry.NM === `(${name})`);
  expect(found.length, name).toBe(1);
  return found[0];
};

interface Markup { name: string; subtype: string; rect: number[]; contents?: string; extra?: Record<string, unknown>; appearance?: string; resources?: Record<string, unknown>; popup?: boolean; replyTo?: string;
  /** The appearance draws text in the fixture's font. */
  lettered?: boolean;
  /** The appearance stream is written with the Flate filter. */
  packed?: boolean }

const DATE = 'D:20240102030405+01\'00\'';

/** A file of another producer: every markup entry carries an author, a
 *  subject, both dates and a name, and each annotation its own appearance. */
async function foreign(extra: Markup[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const times = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', Encoding: 'WinAnsiEncoding' }));
  const state = doc.context.register(doc.context.obj({ Type: 'ExtGState', CA: 0.4, ca: 0.4 }));
  const list: Markup[] = [
    { name: 'note-1', subtype: 'Text', rect: [50, 700, 70, 720], contents: 'First note', popup: true,
      extra: { Name: 'Comment', F: 28, C: [1, 0.8, 0], Open: false, State: PDFString.of('Accepted'), StateModel: PDFString.of('Review') } },
    { name: 'note-2', subtype: 'Text', rect: [100, 700, 120, 720], contents: 'Second note', popup: true,
      extra: { Name: 'Key', F: 28, C: [0, 0.5, 1] }, appearance: '0 0.5 1 rg 0 0 20 20 re f' },
    { name: 'reply-1', subtype: 'Text', rect: [50, 700, 70, 720], contents: 'A reply', replyTo: 'note-1', extra: { F: 28, C: [1, 0.8, 0] } },
    { name: 'text-1', subtype: 'FreeText', rect: [50, 600, 250, 640], contents: 'Ten point text',
      extra: {
        DA: PDFString.of('0 0 1 rg /TiRo 10 Tf'), Q: 1, F: 4, BS: { W: 2, S: 'D', D: [3, 2] }, C: [1, 1, 0.8],
        DS: PDFString.of('font: Times 10pt; text-align:center; color:#0000FF'),
        RC: PDFString.of('<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p>Ten point text</p></body>'),
        Rotate: 0,
      },
      appearance: '1 1 0.8 rg 0 0 200 40 re f BT /TiRo 10 Tf 0 0 1 rg 60 16 Td (Ten point text) Tj ET', resources: { Font: { TiRo: times } } },
    { name: 'mark-1', subtype: 'Highlight', rect: [50, 540, 250, 556], contents: 'Marked', popup: true,
      extra: { QuadPoints: [50, 556, 250, 556, 50, 540, 250, 540], C: [1, 1, 0], CA: 0.4, F: 4 },
      appearance: '/GS7 gs 1 1 0 rg 0 0 200 16 re f', resources: { ExtGState: { GS7: state } } },
    { name: 'ink-1', subtype: 'Ink', rect: [48, 448, 152, 502], contents: 'Drawn',
      extra: { InkList: [[50, 450, 100, 500, 150, 450]], C: [1, 0, 0], BS: { W: 3, S: 'D', D: [4, 2] }, F: 4 },
      appearance: '1 0 0 RG 3 w [4 2] 0 d 2 2 m 52 52 l 102 2 l S' },
    { name: 'square-1', subtype: 'Square', rect: [300, 600, 400, 660], contents: 'Boxed',
      extra: { C: [0, 0.4, 0], IC: [0.8, 1, 0.8], BS: { W: 2 }, F: 4, RD: [1, 1, 1, 1] },
      appearance: '0.8 1 0.8 rg 0 0.4 0 RG 2 w 1 1 98 58 re B' },
    { name: 'line-1', subtype: 'Line', rect: [298, 498, 402, 552], contents: 'Lined',
      extra: { L: [300, 500, 400, 550], LE: ['None', 'OpenArrow'], C: [0, 0, 0.6], BS: { W: 2 }, F: 4, Cap: false },
      appearance: '0 0 0.6 RG 2 w 2 2 m 102 52 l S' },
    { name: 'stamp-1', subtype: 'Stamp', rect: [300, 400, 420, 440], contents: 'Stamped',
      extra: { Name: 'Approved', C: [0, 0.5, 0], F: 4 },
      appearance: 'q 0 0.5 0 rg 0 0 120 40 re f Q BT /TiRo 18 Tf 1 g 10 12 Td (APPROVED) Tj ET', resources: { Font: { TiRo: times } } },
    ...extra,
  ];
  const refs = new Map<string, PDFRef>();
  const entries: PDFRef[] = [];
  for (const item of list) {
    const [x0, y0, x1, y1] = item.rect;
    const dict = doc.context.obj({ Type: 'Annot', Subtype: item.subtype, Rect: item.rect, P: page.ref, ...(item.extra ?? {}) } as never) as unknown as PDFDict;
    dict.set(N('NM'), PDFString.of(item.name));
    dict.set(N('T'), PDFString.of('A. Reviewer'));
    dict.set(N('M'), PDFString.of(DATE));
    dict.set(N('CreationDate'), PDFString.of(DATE));
    dict.set(N('Subj'), PDFString.of(`Subject of ${item.name}`));
    if (item.contents !== undefined) dict.set(N('Contents'), PDFString.of(item.contents));
    if (item.appearance !== undefined) {
      const write = (content: string, entries: never) => (item.packed ? doc.context.flateStream(content, entries) : doc.context.stream(content, entries));
      dict.set(N('AP'), doc.context.obj({ N: doc.context.register(write(item.appearance, {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, x1 - x0, y1 - y0], ...(item.resources ? { Resources: item.resources } : item.lettered ? { Resources: { Font: { TiRo: times } } } : {}),
      } as never)) }));
    }
    if (item.replyTo) dict.set(N('IRT'), refs.get(item.replyTo)!);
    const ref = doc.context.register(dict);
    refs.set(item.name, ref);
    entries.push(ref);
    if (item.popup) {
      const popup = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [x1, y0 - 80, x1 + 160, y0], Parent: ref, Open: false, P: page.ref }));
      dict.set(N('Popup'), popup);
      entries.push(popup);
    }
  }
  const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 50, 150, 70], Border: [0, 0, 0], Dest: [page.ref, 'Fit'] }));
  entries.splice(2, 0, link);
  page.node.set(N('Annots'), doc.context.obj(entries));
  doc.catalog.set(N('AcroForm'), doc.context.register(doc.context.obj({ Fields: [], DR: { Font: { TiRo: times } } })));
  return doc.save({ useObjectStreams: false });
}

const onPage = (edit: (annotation: PageAnnotation) => PageAnnotation | null) => (pages: PageRef[]): PageRef[] =>
  pages.map((page) => {
    const kept: PageAnnotation[] = [];
    const removed: NonNullable<PageAnnotation['importedOriginal']>[] = [];
    for (const annotation of page.annotations ?? []) {
      const next = edit(annotation);
      if (next) kept.push(next);
      else if (annotation.importedOriginal) removed.push(annotation.importedOriginal);
    }
    return { ...page, annotations: kept, ...(removed.length ? { removedImportedOriginals: removed } : {}) };
  });

interface PdfjsNote { subtype: string; hasAppearance: boolean; color: Uint8ClampedArray | null; contentsObj: { str: string } }
async function pdfjsNotes(bytes: Uint8Array): Promise<PdfjsNote[]> {
  const pdf = await loadPdf(bytes);
  const list = (await (await pdf.getPage(1)).getAnnotations()) as PdfjsNote[];
  await pdf.loadingTask.destroy();
  return list.filter((a) => a.subtype === 'Text');
}

/** The content of the icon the build draws for `name` in red. */
function noteIconContent(name: string): string {
  const context = PDFContext.create();
  const stream = context.lookup(noteIconAppearance(context, name, [1, 0, 0]), PDFStream);
  return latin1(stream.getContents());
}

const saying = (text: string) => (annotation: PageAnnotation): boolean => annotation.note === text;
/** The move the reducer applies: the box, and every point with it. */
const moved = (a: PageAnnotation, dx: number, dy: number): PageAnnotation => ({
  ...a, x: a.x + dx, y: a.y + dy,
  ...(a.strokes ? { strokes: a.strokes.map((s) => s.map((v, i) => v + (i % 2 === 0 ? dx : dy))) } : {}),
  ...(a.points ? { points: a.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) } : {}),
  ...(a.importedOriginal ? { geometryDiverged: true } : {}),
});

describe('a commit with no edit of an imported annotation', () => {
  it('imports every kind of the fixture', async () => {
    const [page] = await importedPages(await foreign());
    expect(page.annotations!.map((a) => `${a.kind}:${a.note}`).sort()).toEqual([
      'freetext:Ten point text', 'ink:Drawn', 'note:A reply', 'note:First note', 'note:Second note',
      'shape:Boxed', 'shape:Lined', 'stamp:Stamped', 'textmarkup:Marked',
    ]);
  }, RUN);

  it('leaves every annotation dictionary and appearance stream as written, in the same order', async () => {
    const input = await foreign();
    const output = await commit(input);
    await expectSound(output);
    expect(await annotations(output)).toEqual(await annotations(input));
  }, RUN);

  it('does the same on the commit after', async () => {
    const input = await foreign();
    const twice = await commit(await commit(input));
    await expectSound(twice);
    expect(await annotations(twice)).toEqual(await annotations(input));
  }, RUN);

  it('does the same when the commit adds an annotation', async () => {
    const input = await foreign();
    const output = await commit(input, ([page, ...rest]) => [{
      ...page,
      annotations: [...page.annotations!, { id: 'new', kind: 'highlight', x: 0.6, y: 0.6, w: 0.1, h: 0.05, color: '#ffd54a' }],
    }, ...rest]);
    await expectSound(output);
    const before = await annotations(input);
    const after = await annotations(output);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBe(before.length + 1);
  }, RUN);

  it('does the same under a page rotation', async () => {
    const input = await foreign();
    const output = await commit(input, (pages) => pages.map((page) => ({
      ...page, rotation: 90 as const, annotations: page.annotations!.map((a) => rotateAnnotationRect(a, 90)),
    })));
    await expectSound(output);
    expect(await annotations(output)).toEqual(await annotations(input));
    const doc = await PDFDocument.load(output, { updateMetadata: false });
    expect(doc.getPage(0).getRotation().angle).toBe(90);
  }, RUN);

  it('shows the same text size for the free text in pdf.js', async () => {
    const output = await commit(await foreign());
    const pdf = await loadPdf(output);
    const shown = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string; defaultAppearanceData?: { fontSize: number; fontName: string } }[];
    await pdf.loadingTask.destroy();
    expect(shown.find((a) => a.subtype === 'FreeText')!.defaultAppearanceData).toMatchObject({ fontSize: 10, fontName: 'TiRo' });
  }, RUN);
});

describe('an edit of one imported annotation', () => {
  it('leaves the other note untouched and keeps the edited note\'s author, dates, name and links', async () => {
    const input = await foreign();
    const output = await commit(input, onPage((a) => (saying('First note')(a) ? { ...a, note: 'First note, edited' } : a)));
    await expectSound(output, ['(First note)']);
    const before = await annotations(input);
    const after = await annotations(output);
    for (const name of ['note-2', 'text-1', 'mark-1', 'ink-1', 'square-1', 'line-1', 'stamp-1']) {
      expect(named(after, name), name).toEqual(named(before, name));
    }
    const original = named(before, 'note-1');
    const edited = named(after, 'note-1');
    expect(edited.Contents).toBe('(First note, edited)');
    expect(typeof edited.M).toBe('string');
    expect(edited.M).not.toBe(original.M);
    expect({ ...edited, Contents: null, M: null, Popup: null }).toEqual({ ...original, Contents: null, M: null, Popup: null });
    expect(edited.Popup).toBe('</Popup  >');
    // The popup names the edited note, and the reply still answers it.
    const popup = after.find((entry) => entry.Subtype === '/Popup' && entry.Parent === '</Text note-1 First note, edited>');
    expect(popup).toBeDefined();
    expect(named(after, 'reply-1').IRT).toBe('</Text note-1 First note, edited>');
    expect({ ...named(after, 'reply-1'), IRT: null }).toEqual({ ...named(before, 'reply-1'), IRT: null });
    expect(after.map((entry) => entry.NM ?? entry.Subtype)).toEqual(before.map((entry) => entry.NM ?? entry.Subtype));
  }, RUN);

  it('writes the colour of a recoloured note into /C and into a copy of its appearance', async () => {
    const input = await foreign();
    const output = await commit(input, onPage((a) => (saying('Second note')(a) ? { ...a, color: '#ff0000' } : a)));
    await expectSound(output, ['0 0.5 1 rg']);
    const original = named(await annotations(input), 'note-2');
    const edited = named(await annotations(output), 'note-2');
    expect(edited.C).toEqual([1, 0, 0]);
    const drawn = edited.AP as { N: { data: string; stream: Record<string, unknown> } };
    expect(drawn.N.data).toBe('1 0 0 rg 0 0 20 20 re f');
    expect(drawn.N.stream).toEqual((original.AP as typeof drawn).N.stream);
    expect({ ...edited, C: null, M: null, AP: null }).toEqual({ ...original, C: null, M: null, AP: null });
    expect((await pdfjsNotes(output)).find((a) => a.contentsObj.str === 'Second note')).toMatchObject({ hasAppearance: true, color: new Uint8ClampedArray([255, 0, 0]) });
  }, RUN);

  it('leaves a recoloured note with no appearance as it was: with none', async () => {
    const input = await foreign();
    const output = await commit(input, onPage((a) => (saying('First note')(a) ? { ...a, color: '#ff0000' } : a)));
    await expectSound(output);
    const original = named(await annotations(input), 'note-1');
    const edited = named(await annotations(output), 'note-1');
    expect(edited.C).toEqual([1, 0, 0]);
    expect(edited.AP).toBeUndefined();
    expect({ ...edited, C: null, M: null, Popup: null }).toEqual({ ...original, C: null, M: null, Popup: null });
  }, RUN);

  it('recolours a packed appearance and a gray one, and passes its strings through', async () => {
    const packed: Markup = { name: 'note-5', subtype: 'Text', rect: [200, 700, 220, 720], contents: 'Packed note', packed: true,
      extra: { Name: 'Comment', F: 28, C: [0.5] },
      appearance: '0.5 g 0.5 0.5 0.5 RG 0 0 20 20 re B 0 g BT /TiRo 6 Tf (0.5 g \\) 0.5 G) Tj ET 1 1 18 18 re S', lettered: true };
    const input = await foreign([packed]);
    const output = await commit(input, onPage((a) => (saying('Packed note')(a) ? { ...a, color: '#00ff00' } : a)));
    await expectSound(output);
    const edited = named(await annotations(output), 'note-5');
    expect((edited.AP as { N: { data: string } }).N.data)
      .toBe('0 1 0 rg 0 1 0 RG 0 0 20 20 re B 0 g BT /TiRo 6 Tf (0.5 g \\) 0.5 G) Tj ET 1 1 18 18 re S');
    expect(edited.Name).toBe('/Comment');
  }, RUN);

  it('draws the icon its /Name selects when the appearance does not hold the colour', async () => {
    const shaded: Markup = { name: 'note-4', subtype: 'Text', rect: [200, 650, 220, 670], contents: 'Shaded note',
      extra: { Name: 'Help', F: 28, C: [1, 1, 0] }, appearance: '0.93 0.91 0.2 rg 0 0 20 20 re f' };
    const unnamed: Markup = { name: 'note-6', subtype: 'Text', rect: [240, 650, 260, 670], contents: 'Unnamed note',
      extra: { Name: 'Checkmark', F: 28 }, appearance: '0 0 1 rg 0 0 20 20 re f' };
    const input = await foreign([shaded, unnamed]);
    const output = await commit(input, onPage((a) => (a.note === 'Shaded note' || a.note === 'Unnamed note' ? { ...a, color: '#ff0000' } : a)));
    await expectSound(output, ['0.93 0.91 0.2 rg']);
    const after = await annotations(output);
    type Drawn = { N: { data: string; stream: Record<string, unknown> } };
    const help = (named(after, 'note-4').AP as Drawn).N;
    const fallback = (named(after, 'note-6').AP as Drawn).N;
    expect(help.stream.BBox).toEqual([0, 0, 20, 20]);
    expect(help.data).toBe(noteIconContent('Help'));
    expect(fallback.data).toBe(noteIconContent('Note'));
    expect(help.data.startsWith('1 0 0 rg ')).toBe(true);
    expect(help.data).not.toBe(fallback.data);
    expect(named(after, 'note-4').Name).toBe('/Help');
    for (const note of (await pdfjsNotes(output)).filter((a) => /^(Shaded|Unnamed)/.test(a.contentsObj.str))) expect(note.hasAppearance).toBe(true);
  }, RUN);

  it('keeps the appearance, the icon name and the flags of a reply whose colour changes', async () => {
    const reply: Markup = { name: 'reply-2', subtype: 'Text', rect: [100, 600, 120, 620], contents: 'Second reply', replyTo: 'note-2',
      extra: { Name: 'Comment', F: 28, C: [0, 0.5, 1], RT: 'Group' }, appearance: '0 0.5 1 rg 2 2 16 16 re f' };
    const input = await foreign([reply]);
    const [page] = await importedPages(input);
    const member = page.annotations!.find((a) => a.kind === 'note' && Math.abs(a.importedOriginal!.rect[1] - 600) < 1);
    expect(member).toBeDefined();
    const output = await commit(input, onPage((a) => (a.importedOriginal?.slot === member!.importedOriginal!.slot ? { ...a, color: '#ff0000' } : a)));
    await expectSound(output);
    const edited = named(await annotations(output), 'reply-2');
    expect(edited.C).toEqual([1, 0, 0]);
    expect((edited.AP as { N: { data: string } }).N.data).toBe('1 0 0 rg 2 2 16 16 re f');
    expect(edited.Name).toBe('/Comment');
    expect(edited.F).toBe(28);
    expect(edited.T).toBe('(A. Reviewer)');
  }, RUN);

  it('moves a free text of another producer with its text size, font, alignment, border and appearance', async () => {
    const input = await foreign();
    const output = await commit(input, onPage((a) => (a.kind === 'freetext' ? moved(a, 0.1, 0.05) : a)));
    await expectSound(output);
    const original = named(await annotations(input), 'text-1');
    const edited = named(await annotations(output), 'text-1');
    expect(edited.Rect).toEqual([111.2, 560.4, 311.2, 600.4]);
    expect({ ...edited, Rect: null, M: null }).toEqual({ ...original, Rect: null, M: null });
    expect(edited.DA).toBe('(0 0 1 rg /TiRo 10 Tf)');
    const pdf = await loadPdf(output);
    const shown = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string; defaultAppearanceData?: { fontSize: number } }[];
    await pdf.loadingTask.destroy();
    expect(shown.find((a) => a.subtype === 'FreeText')!.defaultAppearanceData!.fontSize).toBe(10);
  }, RUN);

  it('moves an ink and a line with their coordinates, and keeps the dash pattern and the line endings', async () => {
    const input = await foreign();
    const output = await commit(input, onPage((a) => (a.note === 'Drawn' || a.note === 'Lined' ? moved(a, 0.1, 0.05) : a)));
    await expectSound(output);
    const before = await annotations(input);
    const after = await annotations(output);
    const ink = named(after, 'ink-1');
    expect(ink.InkList).toEqual([[111.2, 410.4, 161.2, 460.4, 211.2, 410.4]]);
    expect(ink.Rect).toEqual([109.2, 408.4, 213.2, 462.4]);
    expect({ ...ink, InkList: null, Rect: null, M: null }).toEqual({ ...named(before, 'ink-1'), InkList: null, Rect: null, M: null });
    const line = named(after, 'line-1');
    expect(line.L).toEqual([361.2, 460.4, 461.2, 510.4]);
    expect({ ...line, L: null, Rect: null, M: null }).toEqual({ ...named(before, 'line-1'), L: null, Rect: null, M: null });
  }, RUN);

  it('keeps the entries the model does not hold when it draws a recoloured shape again', async () => {
    const input = await foreign();
    const output = await commit(input, onPage((a) => (saying('Boxed')(a) ? { ...a, color: '#ff0000' } : a)));
    await expectSound(output);
    const original = named(await annotations(input), 'square-1');
    const edited = named(await annotations(output), 'square-1');
    expect(edited.C).toEqual([1, 0, 0]);
    for (const key of ['T', 'CreationDate', 'Subj', 'NM', 'Contents', 'P']) expect(edited[key], key).toEqual(original[key]);
    expect(edited.IC).toEqual(original.IC);
    expect((edited.AP as { N: { data: string } }).N.data).toContain('1 0 0 RG');
  }, RUN);

  it('changes the comment of a highlight and keeps its appearance, quads and popup', async () => {
    const input = await foreign();
    const output = await commit(input, onPage((a) => (saying('Marked')(a) ? { ...a, note: 'Marked again' } : a)));
    await expectSound(output);
    const original = named(await annotations(input), 'mark-1');
    const after = await annotations(output);
    const edited = named(after, 'mark-1');
    expect(edited.Contents).toBe('(Marked again)');
    expect({ ...edited, Contents: null, M: null, Popup: null }).toEqual({ ...original, Contents: null, M: null, Popup: null });
    expect(after.some((entry) => entry.Subtype === '/Popup' && entry.Parent === '</Highlight mark-1 Marked again>')).toBe(true);
  }, RUN);

  it('drops the rich text of an annotation whose text changed', async () => {
    const rich: Markup = { name: 'note-3', subtype: 'Text', rect: [150, 700, 170, 720], contents: 'Third note',
      extra: { RC: PDFString.of('<body><p>Third note</p></body>'), F: 28 } };
    const input = await foreign([rich]);
    const output = await commit(input, onPage((a) => (saying('Third note')(a) ? { ...a, note: 'Changed' } : a)));
    await expectSound(output, ['Third note']);
    const edited = named(await annotations(output), 'note-3');
    expect(edited.RC).toBeUndefined();
    expect(edited.T).toBe('(A. Reviewer)');
  }, RUN);

  it('draws a changed free text at the text size, alignment and border width of the original', async () => {
    const input = await foreign();
    const output = await commit(input, onPage((a) => (a.kind === 'freetext' ? { ...a, note: 'Changed text' } : a)));
    await expectSound(output, ['Ten point text']);
    const original = named(await annotations(input), 'text-1');
    const edited = named(await annotations(output), 'text-1');
    expect(edited.Contents).toBe('(Changed text)');
    expect(edited.DA).toBe(original.DA);
    expect(edited.Q).toBe(1);
    for (const key of ['T', 'CreationDate', 'Subj', 'NM']) expect(edited[key], key).toEqual(original[key]);
    expect(edited.RC).toBeUndefined();
    const appearance = (edited.AP as { N: { data: string; stream: { Resources: { Font: Record<string, { BaseFont: string }> } } } }).N;
    expect(appearance.data).toContain('/TiRo 10 Tf');
    expect(appearance.data).toContain('2 w');
    expect(appearance.stream.Resources.Font.TiRo.BaseFont).toBe('/Times-Roman');
    const pdf = await loadPdf(output);
    const shown = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string; defaultAppearanceData?: { fontSize: number } }[];
    await pdf.loadingTask.destroy();
    expect(shown.find((a) => a.subtype === 'FreeText')).toMatchObject({ defaultAppearanceData: { fontSize: 10 } });
  }, RUN);
});

describe('two annotations the fingerprint cannot tell apart', () => {
  const twin = (name: string, x: number): Markup => ({ name, subtype: 'Text', rect: [x, 300, x + 20, 320], contents: 'Twin', extra: { F: 28 } });

  it('moves the one the user moved and leaves the other where it is', async () => {
    const input = await foreign([twin('twin-1', 50), twin('twin-2', 400)]);
    expect(await annotations(await commit(input))).toEqual(await annotations(input));
    let seen = 0;
    const edited = await commit(input, onPage((a) => (saying('Twin')(a) && seen++ === 0 ? moved(a, 0.1, 0) : a)));
    await expectSound(edited);
    const before = await annotations(input);
    const after = await annotations(edited);
    expect(named(after, 'twin-2')).toEqual(named(before, 'twin-2'));
    expect(named(after, 'twin-1').Rect).toEqual([111.2, 300, 131.2, 320]);
    let second = 0;
    const other = await annotations(await commit(input, onPage((a) => (saying('Twin')(a) && second++ === 1 ? moved(a, 0.1, 0) : a))));
    expect(named(other, 'twin-1')).toEqual(named(before, 'twin-1'));
    expect(named(other, 'twin-2').Rect).toEqual([461.2, 300, 481.2, 320]);
  }, RUN);

  it('deletes the one the user deleted', async () => {
    const input = await foreign([twin('twin-1', 50), twin('twin-2', 400)]);
    let seen = 0;
    const output = await commit(input, onPage((a) => (saying('Twin')(a) && seen++ === 1 ? null : a)));
    await expectSound(output, ['twin-2']);
    const before = await annotations(input);
    const after = await annotations(output);
    expect(after.filter((entry) => entry.NM !== undefined).map((entry) => entry.NM))
      .toEqual(before.filter((entry) => entry.NM !== '(twin-2)' && entry.NM !== undefined).map((entry) => entry.NM));
    expect(named(after, 'twin-1')).toEqual(named(before, 'twin-1'));
  }, RUN);
});

describe('the order of the annotations', () => {
  it('follows the model when the user sends an untouched annotation to the back', async () => {
    const input = await foreign();
    const output = await commit(input, (pages) => pages.map((page) => {
      const all = page.annotations!;
      const stamp = all.find(saying('Stamped'))!;
      return { ...page, annotations: [stamp, ...all.filter((a) => a !== stamp)] };
    }));
    await expectSound(output);
    const before = await annotations(input);
    const after = await annotations(output);
    const names = (list: Record<string, unknown>[]) => list.map((entry) => entry.NM ?? entry.Subtype);
    expect(names(after)).toEqual(['(stamp-1)', '/Popup', '/Link', '(note-1)', '/Popup', '(note-2)', '(reply-1)', '(text-1)', '/Popup', '(mark-1)', '(ink-1)', '(square-1)', '(line-1)']);
    for (const entry of before) if (entry.NM) expect(named(after, String(entry.NM).slice(1, -1))).toEqual(entry);
  }, RUN);

  it('keeps an edited annotation at its place among the untouched ones', async () => {
    const input = await foreign();
    const output = await commit(input, onPage((a) => (saying('Boxed')(a) ? { ...a, color: '#ff0000' } : a)));
    const names = (list: Record<string, unknown>[]) => list.map((entry) => entry.NM ?? entry.Subtype);
    expect(names(await annotations(output))).toEqual(names(await annotations(input)));
  }, RUN);
});

describe('a deleted imported annotation', () => {
  it('leaves the file with its appearance and its popup, and the others stay as written', async () => {
    const input = await foreign();
    const output = await commit(input, ([page, ...rest]) => [deleting(page, saying('Marked')), ...rest]);
    await expectSound(output, ['mark-1', 'Marked', '/GS7 gs']);
    const before = await annotations(input);
    const after = await annotations(output);
    expect(after.length).toBe(before.length - 2);
    for (const entry of after) if (entry.NM) expect(entry).toEqual(named(before, String(entry.NM).slice(1, -1)));
  }, RUN);
});

describe('a signed document with annotations', () => {
  const SIGNED = resolve('e2e-tests/fixtures/signed.pdf');

  /** The signed fixture with two notes written into its first page. */
  async function reviewed(): Promise<Uint8Array> {
    const doc = await PDFDocument.load(readFileSync(SIGNED), { updateMetadata: false });
    const page = doc.getPage(0);
    const notes = ['KEPTNOTE', 'EDITEDNOTE'].map((text, index) => {
      const note = doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [50 + index * 60, 700, 70 + index * 60, 720], F: 28, P: page.ref, Name: 'Comment' });
      note.set(N('Contents'), PDFString.of(text));
      note.set(N('NM'), PDFString.of(`signed-note-${index}`));
      note.set(N('T'), PDFString.of('A. Reviewer'));
      return doc.context.register(note);
    });
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
    if (annots) notes.forEach((note) => annots.push(note));
    else page.node.set(N('Annots'), doc.context.obj(notes));
    return doc.save({ useObjectStreams: false });
  }

  it('appends the edited annotation and nothing of the untouched one', async () => {
    const original = await reviewed();
    const built = await commit(original, onPage((a) => (saying('EDITEDNOTE')(a) ? { ...a, note: 'NEWTEXT' } : a)));
    const directory = mkdtempSync(resolve('imported-carry.local.d-'));
    try {
      const before = resolve(directory, 'original.pdf'), modified = resolve(directory, 'modified.pdf'), output = resolve(directory, 'output.pdf');
      writeFileSync(before, original);
      writeFileSync(modified, built);
      const report = JSON.parse(execFileSync(testPython(), ['-B', '-c',
        'import json,sys; from engine.incremental import transplant_incremental; print(json.dumps(transplant_incremental(*sys.argv[1:4])))',
        before, modified, output],
      { env: { ...process.env, PYTHONPATH: resolve('src'), PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 30_000 })) as unknown;
      expect(report).toMatchObject({ applied: true });
      const appended = new Uint8Array(readFileSync(output));
      expect(Buffer.from(appended.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
      const revision = latin1(appended.subarray(original.length));
      expect(revision).not.toContain('KEPTNOTE');
      expect(revision).not.toContain('signed-note-0');
      const after = await annotations(appended);
      expect(named(after, 'signed-note-0')).toEqual(named(await annotations(original), 'signed-note-0'));
      expect(named(after, 'signed-note-1')).toMatchObject({ Contents: '(NEWTEXT)', T: '(A. Reviewer)', Name: '/Comment', F: 28 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, RUN);
});

describe('the edit of an imported annotation, read against its import', () => {
  const imported = async (): Promise<PageAnnotation[]> => (await importedPages(await foreign()))[0].annotations!;

  it('is none for every annotation as imported, and each names its position in /Annots', async () => {
    const all = await imported();
    expect(all.map((a) => editIsNone(importedEdit(a)))).toEqual(all.map(() => true));
    expect(all.map((a) => a.importedOriginal!.slot)).toEqual([0, 3, 5, 6, 7, 9, 10, 11, 12]);
  }, RUN);

  it('is none after a page rotation and after a copy of the annotation with new arrays', async () => {
    for (const a of await imported()) {
      expect(editIsNone(importedEdit(rotateAnnotationRect(a, 90))), a.kind).toBe(true);
      expect(editIsNone(importedEdit(rotateAnnotationRect(rotateAnnotationRect(a, 270), 180))), a.kind).toBe(true);
      const copy: PageAnnotation = { ...a, id: 'copy', ...(a.points ? { points: [...a.points] } : {}), ...(a.strokes ? { strokes: a.strokes.map((s) => [...s]) } : {}) };
      expect(editIsNone(importedEdit(copy)), a.kind).toBe(true);
    }
  }, RUN);

  it('tells a move from a change of shape, and reads text, colour and style', async () => {
    const all = await imported();
    const ink = all.find((a) => a.kind === 'ink')!;
    expect(importedEdit(moved(ink, 0.1, 0.05))).toMatchObject({ geometry: 'moved', text: false, color: false, style: false });
    expect(importedEdit(rotateAnnotationRect(moved(ink, 0.1, 0.05), 90))).toMatchObject({ geometry: 'moved' });
    expect(importedEdit({ ...ink, x: ink.x + 0.1 })).toMatchObject({ geometry: 'reshaped' });
    expect(importedEdit({ ...ink, w: ink.w * 2 })).toMatchObject({ geometry: 'reshaped' });
    expect(importedEdit({ ...ink, strokeWidth: 9 })).toMatchObject({ geometry: 'same', style: true });
    expect(importedEdit({ ...ink, note: 'Other' })).toMatchObject({ geometry: 'same', text: true, style: false });
    expect(importedEdit({ ...ink, color: '#123456' })).toMatchObject({ color: true });
    expect(importedEdit({ ...ink, color: '#123456', note: ink.note })).toMatchObject({ text: false });
    const bare: PageAnnotation = { ...ink, importedState: undefined };
    expect(importedEdit(bare)).toBeNull();
  }, RUN);
});

describe('an unedited imported annotation whose original the page does not hold', () => {
  /** The fixture with a second page that holds no annotation. */
  async function twoPages(): Promise<Uint8Array> {
    const doc = await PDFDocument.load(await foreign(), { updateMetadata: false });
    doc.addPage([612, 792]);
    return doc.save({ useObjectStreams: false });
  }

  it('is written, never lost', async () => {
    const input = await twoPages();
    const output = await commit(input, ([first, second]) => {
      const strays = first.annotations!.filter((a) => ['First note', 'Ten point text', 'Marked', 'Boxed', 'Drawn'].includes(a.note ?? ''));
      for (const stray of strays) expect(editIsNone(importedEdit(stray)), stray.note).toBe(true);
      return [first, { ...second, annotations: strays.map((a) => ({ ...a, id: `stray-${a.note}` })) }];
    });
    await expectSound(output);
    expect(await annotations(output, 0)).toEqual(await annotations(input, 0));
    const written = await annotations(output, 1);
    expect(written.map((entry) => `${String(entry.Subtype)} ${String(entry.Contents)}`).sort()).toEqual([
      '/FreeText (Ten point text)', '/Highlight (Marked)', '/Ink (Drawn)', '/Square (Boxed)', '/Text (First note)',
    ]);
  }, RUN);
});

// ISO 32000-2 12.5.6.2: a free text shows /Contents on the page; the other
// markup kinds show it in a popup. 12.5.6.7 Table 178: a line with /Cap true
// shows /Contents as a caption in its appearance.
describe('a new comment on an annotation whose appearance draws its text', () => {
  const captioned: Markup = {
    name: 'line-2', subtype: 'Line', rect: [298, 298, 402, 352], contents: 'Old caption',
    extra: { L: [300, 300, 400, 350], C: [0, 0, 0.6], BS: { W: 2 }, F: 4, Cap: true, CP: 'Top' },
    appearance: '0 0 0.6 RG 2 w 2 2 m 102 52 l S BT /TiRo 9 Tf 30 30 Td (Old caption) Tj ET', lettered: true,
  };

  it('draws a captioned line again, so no appearance shows the old caption', async () => {
    const input = await foreign([captioned]);
    const output = await commit(input, onPage((a) => (saying('Old caption')(a) ? { ...a, note: 'New caption' } : a)));
    await expectSound(output, ['Old caption']);
    const original = named(await annotations(input), 'line-2');
    const edited = named(await annotations(output), 'line-2');
    expect(edited.Contents).toBe('(New caption)');
    expect((edited.AP as { N: { data: string } }).N.data).not.toContain('Old caption');
    // The appearance drawn again holds no caption, and the dictionary asks for none.
    expect(edited.Cap).toBeUndefined();
    expect(edited.L).toEqual(original.L);
    for (const key of ['T', 'CreationDate', 'Subj', 'NM']) expect(edited[key], key).toEqual(original[key]);
  }, RUN);

  it('keeps the appearance of a line with no caption', async () => {
    const input = await foreign([captioned]);
    const output = await commit(input, onPage((a) => (saying('Lined')(a) ? { ...a, note: 'Lined again' } : a)));
    await expectSound(output);
    const original = named(await annotations(input), 'line-1');
    const edited = named(await annotations(output), 'line-1');
    expect(edited.Contents).toBe('(Lined again)');
    expect({ ...edited, Contents: null, M: null }).toEqual({ ...original, Contents: null, M: null });
    expect(named(await annotations(output), 'line-2')).toEqual(named(await annotations(input), 'line-2'));
  }, RUN);

  it('keeps the caption and the appearance of a moved captioned line', async () => {
    const input = await foreign([captioned]);
    const output = await commit(input, onPage((a) => (saying('Old caption')(a) ? moved(a, 0.1, 0.05) : a)));
    await expectSound(output);
    const original = named(await annotations(input), 'line-2');
    const edited = named(await annotations(output), 'line-2');
    expect(edited.Cap).toBe('true');
    expect(edited.AP).toEqual(original.AP);
    expect(edited.Contents).toBe('(Old caption)');
  }, RUN);
});

describe('a content stream with one colour set to another', () => {
  const bytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));
  const run = (text: string, from: number[], to: [number, number, number] = [1, 0, 0]): string | null => {
    const out = recolouredContent(bytes(text), from, to);
    return out ? latin1(out) : null;
  };

  it('sets the fill and the stroke colour that equal the colour, and no other', () => {
    expect(run('1 1 0 rg 0 0 1 RG 1 1 0 RG 0.4 0.4 0.4 rg', [1, 1, 0])).toBe('1 0 0 rg 0 0 1 RG 1 0 0 RG 0.4 0.4 0.4 rg');
    expect(run('1 1 0 rg', [1, 1, 0], [0.2, 0.4, 0.6])).toBe('0.2 0.4 0.6 rg');
    expect(run('0.9999 1.0 0 rg', [1, 1, 0])).toBe('1 0 0 rg');
    expect(run('0.98 1 0 rg', [1, 1, 0])).toBeNull();
  });

  it('reads a gray as the RGB colour with three equal components, and a CMYK colour as itself', () => {
    expect(run('0.5 g 0.5 G', [0.5, 0.5, 0.5])).toBe('1 0 0 rg 1 0 0 RG');
    expect(run('0.5 0.5 0.5 rg', [0.5])).toBe('1 0 0 rg');
    expect(run('0 1 1 0 k 0 1 1 0 K', [0, 1, 1, 0])).toBe('1 0 0 rg 1 0 0 RG');
    expect(run('0 1 1 0 k', [1, 0, 0])).toBeNull();
  });

  it('takes the last operands before the operator, and none across another operator', () => {
    expect(run('5 1 1 0 rg', [1, 1, 0])).toBe('5 1 0 0 rg');
    expect(run('1 1 m 0 rg', [1, 1, 0])).toBeNull();
    expect(run('1 1 [0] rg', [1, 1, 0])).toBeNull();
  });

  it('passes strings, comments, dictionaries and inline image data through', () => {
    const text = '(1 1 0 rg \\) 1 1 0 rg) Tj <31203120302072> Tj % 1 1 0 rg\n/P << /MCID 0 >> BDC BI /W 1 /H 1 ID 1 1 0 rg \nEI 1 1 0 rg EMC';
    expect(run(text, [1, 1, 0])).toBe(text.replace(/1 1 0 rg EMC$/, '1 0 0 rg EMC'));
  });

  it('gives nothing for a colour of no device space', () => {
    expect(run('1 1 0 rg', [])).toBeNull();
    expect(run('1 1 0 rg', [1, 1])).toBeNull();
  });
});
