// A stamp with the NoRotate flag keeps its orientation on the screen when the
// page is rotated: the upper-left corner of /Rect in default user space stays
// where the page rotation puts it, and /Rect itself does not change (ISO
// 32000-2 12.5.3, Table 167 and the text after it). The import, a move, a
// resize and a page rotation of a carried stamp follow that rule.

import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import type { PageAnnotation, PageRef } from '../src/renderer/state/types';
import { commit, importedPages } from './support/commit-cycle';
import {
  displayPointToPdf, pdfPointToDisplay, pdfRectToDisplay, pdfRectToUprightDisplay, uprightDisplayToPdfRect,
} from '../src/renderer/lib/pdfx-build';

const { displayFrame, rotateAnnotationRect } = await import('../src/renderer/state/reducer');

const ROTATIONS = [0, 90, 180, 270] as const;
const BOX = { x: 0, y: 0, width: 400, height: 600 };
const RECT: [number, number, number, number] = [50, 400, 250, 500];
const CONTROL: [number, number, number, number] = [60, 100, 160, 140];
const NO_ROTATE = 16;

/** One page per /Rotate. Each holds a NoRotate stamp at RECT and a stamp
 *  without the flag at CONTROL; neither appearance is the label's. */
async function fixture(flags = 4 + NO_ROTATE, label = false): Promise<Uint8Array> {
  // The resources of the label the commit draws itself, or none.
  const resources = label
    ? { Font: { HelvB: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica-Bold' } }, ExtGState: { GS0: { CA: 1 } } }
    : {};
  const doc = await PDFDocument.create();
  for (const rotate of ROTATIONS) {
    const page = doc.addPage([BOX.width, BOX.height]);
    if (rotate) page.node.set(PDFName.of('Rotate'), doc.context.obj(rotate));
    const appearance = doc.context.register(doc.context.stream('1 0 0 rg 0 0 50 40 re f 0 0 1 rg 50 0 50 40 re f', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Resources: resources,
    }));
    const fixed = doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: RECT, F: flags, AP: { N: appearance }, NM: 'fixed' });
    const turning = doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: CONTROL, F: 4, AP: { N: appearance }, NM: 'turning' });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(fixed), doc.context.register(turning)]));
  }
  return doc.save();
}

interface Saved {
  rotate: number;
  rect: number[];
  flags: number;
}

/** The stamp named `name` of each page of a saved file. */
async function saved(bytes: Uint8Array, name: string): Promise<Saved[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i, PDFDict);
      if (String(dict.lookup(PDFName.of('NM'))).includes(name)) {
        return {
          rotate: page.getRotation().angle,
          rect: dict.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => Number((n as PDFNumber).asNumber().toFixed(4))),
          flags: dict.lookup(PDFName.of('F'), PDFNumber).asNumber(),
        };
      }
    }
    throw new Error(`no stamp ${name}`);
  });
}

const near = (values: number[]): number[] => values.map((v) => Number(v.toFixed(6)));
const boxOf = (a: { x: number; y: number; w: number; h: number }): number[] => near([a.x, a.y, a.w, a.h]);
const shownSize = (rotate: number): { width: number; height: number } =>
  rotate % 180 === 90 ? { width: BOX.height, height: BOX.width } : { width: BOX.width, height: BOX.height };

/** The pages as the index records them, with the size pdf.js gives each. */
async function pagesOf(bytes: Uint8Array): Promise<PageRef[]> {
  return (await importedPages(bytes)).map((page, index) => ({ ...page, ...shownSize(ROTATIONS[index]) }));
}

const stamp = (page: PageRef, fixed: boolean): PageAnnotation =>
  page.annotations!.find((a) => a.kind === 'stamp' && (a.noRotate === true) === fixed)!;

const onEach = (change: (a: PageAnnotation, page: PageRef, index: number) => PageAnnotation) =>
  (pages: PageRef[]): PageRef[] => pages.map((page, index) => ({
    ...page,
    ...shownSize(ROTATIONS[index]),
    annotations: page.annotations!.map((a) => (a.noRotate ? change(a, { ...page, ...shownSize(ROTATIONS[index]) }, index) : a)),
  }));

describe('the upright box of a NoRotate rectangle', () => {
  it('starts at the upper-left corner of the rectangle and keeps its width and height', () => {
    for (const rotate of ROTATIONS) {
      const shown = shownSize(rotate);
      const [x, y] = pdfPointToDisplay(RECT[0], RECT[3], BOX, rotate);
      expect(boxOf(pdfRectToUprightDisplay(RECT, BOX, rotate))).toEqual(near([x, y, 200 / shown.width, 100 / shown.height]));
    }
    // Without a page rotation it is the box of any annotation.
    expect(boxOf(pdfRectToUprightDisplay(RECT, BOX, 0))).toEqual(boxOf(pdfRectToDisplay(RECT, BOX, 0)));
    // With one it is another box than the one that turns with the page.
    expect(boxOf(pdfRectToUprightDisplay(RECT, BOX, 90))).not.toEqual(boxOf(pdfRectToDisplay(RECT, BOX, 90)));
  });

  it('maps back to the rectangle for every page rotation and a crop offset', () => {
    const cropped = { x: 20, y: 30, width: 360, height: 540 };
    for (const box of [BOX, cropped]) {
      for (const rotate of ROTATIONS) {
        expect(near(uprightDisplayToPdfRect(pdfRectToUprightDisplay(RECT, box, rotate), box, rotate))).toEqual(RECT);
      }
    }
  });

  it('turns with a pending page rotation to the upright box of the new rotation', () => {
    for (const rotate of ROTATIONS) {
      for (const delta of [90, 180, 270]) {
        const before: PageAnnotation = { id: 's', kind: 'stamp', color: '#000000', noRotate: true, ...pdfRectToUprightDisplay(RECT, BOX, rotate) };
        const turned = rotateAnnotationRect(before, delta, shownSize(rotate));
        expect(boxOf(turned)).toEqual(boxOf(pdfRectToUprightDisplay(RECT, BOX, rotate + delta)));
      }
    }
    // Four quarter turns give the box back.
    let a: PageAnnotation = { id: 's', kind: 'stamp', color: '#000000', noRotate: true, ...pdfRectToUprightDisplay(RECT, BOX, 0) };
    let frame = shownSize(0);
    for (let i = 0; i < 4; i++) {
      a = rotateAnnotationRect(a, 90, frame);
      frame = { width: frame.height, height: frame.width };
    }
    expect(boxOf(a)).toEqual(boxOf(pdfRectToUprightDisplay(RECT, BOX, 0)));
  });

  it('reads the display size of a page under its pending rotation', () => {
    expect([0, 90, 180, 270].map((rotation) => displayFrame({ width: 400, height: 600, rotation }))).toEqual([
      { width: 400, height: 600 }, { width: 600, height: 400 }, { width: 400, height: 600 }, { width: 600, height: 400 },
    ]);
  });
});

describe('a carried stamp with the NoRotate flag', () => {
  it('is imported at its upright box on every page rotation, and a stamp without the flag turns with the page', async () => {
    const pages = await pagesOf(await fixture());
    pages.forEach((page, index) => {
      const rotate = ROTATIONS[index];
      const fixed = stamp(page, true);
      expect(fixed.carriedAppearance).toBeDefined();
      expect(boxOf(fixed)).toEqual(boxOf(pdfRectToUprightDisplay(RECT, BOX, rotate)));
      const turning = stamp(page, false);
      expect(turning.noRotate).toBeUndefined();
      expect(boxOf(turning)).toEqual(boxOf(pdfRectToDisplay(CONTROL, BOX, rotate)));
    });
  });

  it('keeps /Rect and the flag as written when another annotation of the page is edited', async () => {
    const out = await commit(await fixture(), (pages) => pages.map((page) => ({
      ...page,
      annotations: page.annotations!.map((a) => (a.noRotate ? a : { ...a, color: '#123456' })),
    })));
    expect(await saved(out, 'fixed')).toEqual(ROTATIONS.map((rotate) => ({ rotate, rect: RECT, flags: 4 + NO_ROTATE })));
  });

  it('writes a move as the new upper-left corner with the size unchanged', async () => {
    const out = await commit(await fixture(), onEach((a) => ({ ...a, x: a.x + 0.05, y: a.y - 0.1, geometryDiverged: true })));
    const before = await pagesOf(await fixture());
    (await saved(out, 'fixed')).forEach(({ rotate, rect, flags }, index) => {
      const moved = stamp(before[index], true);
      const [left, top] = displayPointToPdf(moved.x + 0.05, moved.y - 0.1, BOX, rotate);
      expect(rect).toEqual(near([left, top - 100, left + 200, top]).map((v) => Number(v.toFixed(4))));
      expect(flags).toBe(4 + NO_ROTATE);
    });
    // The read-back box is the box the user left.
    (await pagesOf(out)).forEach((page, index) => {
      const moved = stamp(before[index], true);
      expect(boxOf(stamp(page, true))).toEqual(near([moved.x + 0.05, moved.y - 0.1, moved.w, moved.h]));
    });
  });

  it('writes a resize as a new width and height from the same corner', async () => {
    const out = await commit(await fixture(), onEach((a) => ({ ...a, w: a.w * 1.5, h: a.h * 0.5, geometryDiverged: true })));
    expect((await saved(out, 'fixed')).map(({ rect }) => rect)).toEqual(ROTATIONS.map(() => [50, 450, 350, 500]));
    (await pagesOf(out)).forEach((page, index) => {
      const shown = shownSize(ROTATIONS[index]);
      const resized = stamp(page, true);
      expect(near([resized.w * shown.width, resized.h * shown.height])).toEqual([300, 50]);
    });
  });

  it('keeps /Rect as written through a committed page rotation, and the read-back is upright at the new rotation', async () => {
    for (const delta of [90, 180, 270] as const) {
      const out = await commit(await fixture(), (pages) => pages.map((page, index) => {
        const sized = { ...page, ...shownSize(ROTATIONS[index]) };
        return { ...sized, rotation: delta, annotations: sized.annotations!.map((a) => rotateAnnotationRect(a, delta, displayFrame(sized))) };
      }));
      expect(await saved(out, 'fixed')).toEqual(ROTATIONS.map((rotate) => ({ rotate: (rotate + delta) % 360, rect: RECT, flags: 4 + NO_ROTATE })));
      // The stamp without the flag keeps its rectangle too: it turns with the page.
      expect((await saved(out, 'turning')).map(({ rect }) => rect)).toEqual(ROTATIONS.map(() => CONTROL));
      (await importedPages(out)).forEach((page, index) => {
        expect(boxOf(stamp(page, true))).toEqual(boxOf(pdfRectToUprightDisplay(RECT, BOX, ROTATIONS[index] + delta)));
      });
    }
  });

  it('writes a move made under a pending page rotation', async () => {
    const out = await commit(await fixture(), (pages) => pages.map((page, index) => {
      const sized = { ...page, ...shownSize(ROTATIONS[index]) };
      return {
        ...sized,
        rotation: 90 as const,
        annotations: sized.annotations!
          .map((a) => rotateAnnotationRect(a, 90, displayFrame(sized)))
          .map((a) => (a.noRotate ? { ...a, x: a.x + 0.1, y: a.y + 0.05, geometryDiverged: true } : a)),
      };
    }));
    (await saved(out, 'fixed')).forEach(({ rotate, rect }, index) => {
      expect(rotate).toBe((ROTATIONS[index] + 90) % 360);
      const turned = pdfRectToUprightDisplay(RECT, BOX, rotate);
      const [left, top] = displayPointToPdf(turned.x + 0.1, turned.y + 0.05, BOX, rotate);
      expect(rect).toEqual([left, top - 100, left + 200, top].map((v) => Number(v.toFixed(4))));
    });
  });

  it('does not take the upright box for a stamp the commit draws again', async () => {
    // The label's own resources: the import re-authors it, and a re-authored
    // stamp turns with the page.
    const label = await fixture(4 + NO_ROTATE, true);
    (await pagesOf(label)).forEach((page, index) => {
      const drawn = page.annotations!.find((a) => a.kind === 'stamp' && a.carriedAppearance === undefined)!;
      expect(drawn.noRotate).toBeUndefined();
      expect(boxOf(drawn)).toEqual(boxOf(pdfRectToDisplay(RECT, BOX, ROTATIONS[index])));
    });
  });
});
