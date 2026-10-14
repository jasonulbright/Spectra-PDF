// An imported annotation whose appearance the commit keeps as written is
// shown on the canvas from that appearance, on the rectangle the commit
// writes: the original's /Rect moved by the user's move (ISO 32000-2 12.5.5).
// The rule that picks those annotations is the model's side of the build's
// rule, and the place is the place the committed file shows.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import type { PageAnnotation, PageRef } from '../src/renderer/state/types';
import { rotateAnnotationRect } from '../src/renderer/state/reducer';
import { editIsNone, importedEdit, keptAppearanceMove } from '../src/renderer/lib/imported-edit';
import { originalAppearancePlacement } from '../src/renderer/lib/appearance-preview';
import { pdfRectToDisplay } from '../src/renderer/lib/pdfx-build';
import { rotateNormalizedRect } from '../src/renderer/lib/redaction';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit, importedPages } from './support/commit-cycle';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const N = PDFName.of;
const RUN = 60_000;
const VIEW: [number, number, number, number] = [0, 0, 400, 600];

/** One page of 400 by 600 with a free text, an ink, a line with a caption, a
 *  line with none, a square, a note and a stamp, each with an appearance, and
 *  an ink with none. */
async function fixture(rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  if (rotate) page.node.set(N('Rotate'), doc.context.obj(rotate));
  const form = (content: string, width: number, height: number) => ({ N: doc.context.register(doc.context.stream(content, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: {},
  })) });
  const list: Record<string, unknown>[] = [
    { Subtype: 'FreeText', Rect: [50, 400, 250, 500], Contents: PDFString.of('Free'), DA: PDFString.of('0 g /Helv 12 Tf'), AP: form('1 0 0 rg 0 0 200 100 re f', 200, 100) },
    { Subtype: 'Ink', Rect: [48, 298, 152, 352], Contents: PDFString.of('Drawn'), InkList: [[50, 300, 100, 350, 150, 300]], C: [1, 0, 0], BS: { W: 3 }, AP: form('1 0 0 RG 3 w 2 2 m 52 52 l 102 2 l S', 104, 54) },
    { Subtype: 'Line', Rect: [198, 298, 302, 352], Contents: PDFString.of('Captioned'), L: [200, 300, 300, 350], C: [0, 0, 1], BS: { W: 2 }, Cap: true, AP: form('0 0 1 RG 2 w 2 2 m 102 52 l S', 104, 54) },
    { Subtype: 'Line', Rect: [198, 198, 302, 252], Contents: PDFString.of('Plain'), L: [200, 200, 300, 250], C: [0, 0, 1], BS: { W: 2 }, AP: form('0 0 1 RG 2 w 2 2 m 102 52 l S', 104, 54) },
    { Subtype: 'Square', Rect: [50, 100, 150, 160], Contents: PDFString.of('Boxed'), C: [0, 0.4, 0], BS: { W: 2 }, AP: form('0 0.4 0 RG 2 w 1 1 98 58 re S', 100, 60) },
    { Subtype: 'Text', Rect: [300, 500, 320, 520], Contents: PDFString.of('Noted'), C: [1, 1, 0], Name: 'Note', AP: form('1 1 0 rg 0 0 20 20 re f', 20, 20) },
    { Subtype: 'Stamp', Rect: [250, 50, 350, 90], Contents: PDFString.of('Stamped'), AP: form('0 0.5 0 rg 0 0 100 40 re f', 100, 40) },
    { Subtype: 'Ink', Rect: [300, 400, 380, 480], Contents: PDFString.of('Bare'), InkList: [[310, 410, 370, 470]], C: [0, 0, 0] },
  ];
  page.node.set(N('Annots'), doc.context.obj(list.map((entry) => doc.context.register(doc.context.obj({ Type: 'Annot', F: 4, ...entry } as never)))));
  return doc.save({ useObjectStreams: false });
}

const byNote = (pages: PageRef[], note: string): PageAnnotation => {
  const found = pages[0].annotations!.find((a) => a.note === note);
  expect(found, note).toBeDefined();
  return found!;
};
const moved = (a: PageAnnotation, dx: number, dy: number): PageAnnotation => ({
  ...a, x: a.x + dx, y: a.y + dy,
  ...(a.strokes ? { strokes: a.strokes.map((s) => s.map((v, i) => v + (i % 2 === 0 ? dx : dy))) } : {}),
  ...(a.points ? { points: a.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) } : {}),
  geometryDiverged: true,
});
const close = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): void => {
  for (const key of ['x', 'y', 'w', 'h'] as const) expect(a[key], key).toBeCloseTo(b[key], 6);
};

describe('the appearance an import records', () => {
  it('names the original for every import with an appearance that is no stamp, and is no edit', async () => {
    const pages = await importedPages(await fixture());
    const recorded = Object.fromEntries(pages[0].annotations!.map((a) => [a.note, a.originalAppearance]));
    expect(Object.keys(recorded).sort()).toEqual(['Bare', 'Boxed', 'Captioned', 'Drawn', 'Free', 'Noted', 'Plain', 'Stamped']);
    for (const note of ['Boxed', 'Drawn', 'Noted', 'Plain']) expect(recorded[note], note).toEqual({ id: expect.stringMatching(/^\d+R$/) as unknown as string });
    for (const note of ['Free', 'Captioned']) expect(recorded[note], note).toEqual({ id: expect.stringMatching(/^\d+R$/) as unknown as string, drawsText: true });
    expect(recorded.Stamped).toBeUndefined();
    expect(recorded.Bare).toBeUndefined();
    for (const a of pages[0].annotations!) expect(editIsNone(importedEdit(a)), a.note).toBe(true);
  }, RUN);
});

describe('which edits keep the appearance on the canvas', () => {
  it('a move does, and gives its distance', async () => {
    const pages = await importedPages(await fixture());
    for (const note of ['Free', 'Drawn', 'Captioned', 'Plain', 'Boxed', 'Noted']) {
      const a = byNote(pages, note);
      expect(keptAppearanceMove(a), note).toEqual({ dx: 0, dy: 0 });
      const kept = keptAppearanceMove(moved(a, 0.1, -0.05));
      expect(kept, note).not.toBeNull();
      expect(kept!.dx).toBeCloseTo(0.1, 9);
      expect(kept!.dy).toBeCloseTo(-0.05, 9);
    }
  }, RUN);

  it('a change of shape, colour or style does not, and neither does a stamp or an import with no appearance', async () => {
    const pages = await importedPages(await fixture());
    const free = byNote(pages, 'Free');
    expect(keptAppearanceMove({ ...free, w: free.w * 1.5 })).toBeNull();
    expect(keptAppearanceMove({ ...moved(free, 0.1, 0), color: '#00ff00' })).toBeNull();
    expect(keptAppearanceMove({ ...moved(byNote(pages, 'Boxed'), 0.1, 0), strokeWidth: 9 })).toBeNull();
    const ink = byNote(pages, 'Drawn');
    expect(keptAppearanceMove({ ...ink, strokes: ink.strokes!.map((s) => s.map((v, i) => (i === 0 ? v + 0.01 : v))) })).toBeNull();
    expect(keptAppearanceMove(moved(byNote(pages, 'Stamped'), 0.1, 0))).toBeNull();
    expect(keptAppearanceMove(moved(byNote(pages, 'Bare'), 0.1, 0))).toBeNull();
    expect(keptAppearanceMove({ ...moved(free, 0.1, 0), baked: true })).toBeNull();
  }, RUN);

  it('a new text does where the appearance does not draw the text', async () => {
    const pages = await importedPages(await fixture());
    for (const note of ['Drawn', 'Plain', 'Boxed', 'Noted']) {
      expect(keptAppearanceMove({ ...moved(byNote(pages, note), 0.1, 0), note: 'Changed' }), note).not.toBeNull();
      expect(keptAppearanceMove({ ...byNote(pages, note), note: 'Changed' }), note).toEqual({ dx: 0, dy: 0 });
    }
    for (const note of ['Free', 'Captioned']) {
      expect(keptAppearanceMove({ ...moved(byNote(pages, note), 0.1, 0), note: 'Changed' }), note).toBeNull();
    }
  }, RUN);

  it('a move in progress counts by its box, and a resize in progress does not', async () => {
    const pages = await importedPages(await fixture());
    const ink = byNote(pages, 'Drawn');
    const kept = keptAppearanceMove(ink, { x: ink.x + 0.2, y: ink.y + 0.1, w: ink.w, h: ink.h });
    expect(kept!.dx).toBeCloseTo(0.2, 9);
    expect(kept!.dy).toBeCloseTo(0.1, 9);
    expect(keptAppearanceMove(ink, { x: ink.x, y: ink.y, w: ink.w * 2, h: ink.h })).toBeNull();
    // A drag of an annotation the user moved before starts from the import.
    const before = moved(ink, 0.05, 0);
    expect(keptAppearanceMove(before, { x: before.x + 0.1, y: before.y, w: before.w, h: before.h })!.dx).toBeCloseTo(0.15, 9);
  }, RUN);

  it('agrees with the build: the commit of each such edit leaves the appearance stream as written', async () => {
    const input = await fixture();
    const streamOf = async (bytes: Uint8Array, contents: RegExp): Promise<string | undefined> => {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const annots = doc.getPage(0).node.lookup(N('Annots'), PDFArray);
      for (let i = 0; i < annots.size(); i++) {
        const dict = annots.lookup(i, PDFDict);
        const text = dict.lookup(N('Contents'));
        if (!(text instanceof PDFString) && !(text && 'decodeText' in text)) continue;
        if (!contents.test((text as PDFString).decodeText())) continue;
        const ap = dict.lookup(N('AP'));
        const normal = ap instanceof PDFDict ? ap.lookup(N('N')) : undefined;
        return normal ? Buffer.from((normal as unknown as { getContents(): Uint8Array }).getContents()).toString('latin1') : undefined;
      }
      return undefined;
    };
    const cases: [string, (a: PageAnnotation) => PageAnnotation, boolean][] = [
      ['Free', (a) => moved(a, 0.1, 0.05), true],
      ['Drawn', (a) => ({ ...moved(a, 0.1, 0.05), note: 'Drawn again' }), true],
      ['Plain', (a) => ({ ...moved(a, 0.1, 0.05), note: 'Plain again' }), true],
      ['Captioned', (a) => ({ ...moved(a, 0.1, 0.05), note: 'Captioned again' }), false],
      ['Free', (a) => ({ ...moved(a, 0.1, 0.05), note: 'Free again' }), false],
      ['Boxed', (a) => ({ ...a, w: a.w * 1.2 }), false],
    ];
    for (const [note, edit, keeps] of cases) {
      const [page] = await importedPages(input);
      const edited = edit(byNote([page], note));
      expect(keptAppearanceMove(edited) !== null, `${note} rule`).toBe(keeps);
      const output = await commit(input, ([first, ...rest]) => [{ ...first, annotations: first.annotations!.map((a) => (a.note === note ? edit(a) : a)) }, ...rest]);
      const before = await streamOf(input, new RegExp(`^${note}$`));
      const after = await streamOf(output, new RegExp(`^${note}`));
      expect(before, note).toBeDefined();
      expect(after === before, `${note} build`).toBe(keeps);
    }
  }, RUN);
});

describe('where the kept appearance is drawn', () => {
  const raster = (rect: [number, number, number, number], pageRotate: 0 | 90 | 180 | 270) => ({ rect, view: VIEW, pageRotate });

  it('is the original rectangle as the page shows it, for every page rotation, pending rotation and view turn', async () => {
    for (const rotate of [0, 90, 180, 270] as const) {
      const [page] = await importedPages(await fixture(rotate));
      const square = byNote([page], 'Boxed');
      const rect = square.importedOriginal!.rect;
      for (const pending of [0, 90, 180, 270]) {
        for (const view of [0, 90, 270]) {
          const placement = originalAppearancePlacement(raster(rect, rotate), { dx: 0, dy: 0 }, pending, view);
          // The model box of a square is its rectangle: the model turned by
          // the pending rotation, then shown under the view turn.
          const turned = rotateAnnotationRect(square, pending);
          close(placement.box, rotateNormalizedRect({ x: turned.x, y: turned.y, w: turned.w, h: turned.h }, view));
          close(placement.box, pdfRectToDisplay(rect, { x: 0, y: 0, width: 400, height: 600 }, rotate + pending + view));
          expect(placement.turn).toBe((rotate + pending + view) % 360);
        }
      }
    }
  }, RUN);

  it('is wider than the model box of an ink by the padding of its rectangle', async () => {
    const [page] = await importedPages(await fixture());
    const ink = byNote([page], 'Drawn');
    const placement = originalAppearancePlacement(raster(ink.importedOriginal!.rect, 0), { dx: 0, dy: 0 }, 0, 0);
    close(placement.box, { x: 48 / 400, y: (600 - 352) / 600, w: 104 / 400, h: 54 / 600 });
    expect(placement.box.w).toBeGreaterThan(ink.w);
    expect(placement.box.x).toBeLessThan(ink.x);
  }, RUN);

  it('is the rectangle the commit writes for the move', async () => {
    for (const rotate of [0, 90] as const) {
      const input = await fixture(rotate);
      for (const note of ['Free', 'Drawn', 'Plain']) {
        const [page] = await importedPages(input);
        const edited = moved(byNote([page], note), 0.1, 0.05);
        const kept = keptAppearanceMove(edited)!;
        const placement = originalAppearancePlacement(raster(edited.importedOriginal!.rect, rotate), kept, 0, 0);
        const output = await commit(input, ([first, ...rest]) => [{ ...first, annotations: first.annotations!.map((a) => (a.note === note ? moved(a, 0.1, 0.05) : a)) }, ...rest]);
        const doc = await PDFDocument.load(output, { updateMetadata: false });
        const annots = doc.getPage(0).node.lookup(N('Annots'), PDFArray);
        let written: number[] | undefined;
        for (let i = 0; i < annots.size(); i++) {
          const dict = annots.lookup(i, PDFDict);
          const text = dict.lookup(N('Contents'));
          if (text instanceof PDFString && text.decodeText() === note) written = dict.lookup(N('Rect'), PDFArray).asArray().map((v) => (v as PDFNumber).asNumber());
        }
        expect(written, note).toBeDefined();
        close(placement.box, pdfRectToDisplay(written as [number, number, number, number], { x: 0, y: 0, width: 400, height: 600 }, rotate));
      }
    }
  }, RUN);
});
