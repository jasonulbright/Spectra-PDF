// A stamp the commit wrote is read back from the file by the import before
// the next commit. The import holds a stamp's rectangle, colour and text, and
// no drawing. The next commit of the same file writes every imported
// annotation again. An image stamp, a typed signature and a stamp of another
// producer keep the appearance they had: the image is still painted, the
// signature is still set in its face.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PageAnnotation, PageRef } from '../src/renderer/state/types';

const FONT_DIR = join(__dirname, '..', 'resources', 'fonts');
// Guarded on the face file: an empty resources/fonts directory holds no face.
const HAS_FACES = existsSync(join(FONT_DIR, 'GreatVibes-Regular.ttf'));

vi.mock('../src/renderer/lib/signature-fonts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/lib/signature-fonts')>();
  return {
    ...real,
    loadSignatureFontBytes: async (id: string) => {
      const face = real.signatureFaceById(id);
      if (!face) throw new Error(`unknown signature face: ${id}`);
      return new Uint8Array(readFileSync(join(FONT_DIR, face.file)));
    },
  };
});

const { commit, deleting, importedPages } = await import('./support/commit-cycle');
const { annotsOf, expectSound, latin1, loadPdf, subtypeOf } = await import('./support/saved-pdf');
const { rotateAnnotationRect } = await import('../src/renderer/state/reducer');

const N = PDFName.of;
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function blankPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 600]);
  return doc.save();
}

const placing = (added: Omit<PageAnnotation, 'id'>) => ([page, ...rest]: PageRef[]): PageRef[] =>
  [{ ...page, annotations: [...(page.annotations ?? []), { id: `placed-${(page.annotations ?? []).length}`, ...added }] }, ...rest];

const IMAGE_STAMP: Omit<PageAnnotation, 'id'> =
  { kind: 'stamp', x: 0.2, y: 0.4, w: 0.3, h: 0.1, color: '#14213d', note: 'Scanned', imageData: PNG };
const TYPED_SIGNATURE: Omit<PageAnnotation, 'id'> =
  { kind: 'stamp', x: 0.2, y: 0.4, w: 0.35, h: 0.08, color: '#14213d', note: 'Ada Lovelace', signatureFont: 'greatvibes' };
const HIGHLIGHT: Omit<PageAnnotation, 'id'> = { kind: 'highlight', x: 0.1, y: 0.8, w: 0.2, h: 0.05, color: '#ffd54a' };

/** Another edit on the stamp's page: the user adds a highlight. */
const otherEdit = placing(HIGHLIGHT);

/** The page's one stamp, edited. */
const editStamp = (change: (stamp: PageAnnotation) => PageAnnotation) => ([page, ...rest]: PageRef[]): PageRef[] =>
  [{ ...page, annotations: page.annotations!.map((a) => (a.kind === 'stamp' ? change(a) : a)) }, ...rest];

interface StampReading {
  count: number;
  rect: number[];
  contents: string;
  /** The normal appearance's content stream. */
  content: string;
  /** Subtype of each XObject the appearance names. */
  xobjects: string[];
  /** BaseFont of each font the appearance names. */
  fonts: string[];
  dict: PDFDict;
}

function stampOf(doc: PDFDocument, pageIndex = 0): StampReading {
  const stamps = annotsOf(doc, pageIndex).filter((a) => subtypeOf(a.dict) === '/Stamp');
  const dict = stamps[0]?.dict;
  if (!dict) return { count: 0, rect: [], contents: '', content: '', xobjects: [], fonts: [], dict: doc.context.obj({}) };
  const normal = dict.lookup(N('AP'), PDFDict).lookup(N('N'), PDFStream);
  const resources = normal.dict.lookupMaybe(N('Resources'), PDFDict);
  const entries = (kind: string, key: string): string[] => {
    const table = resources?.lookupMaybe(N(kind), PDFDict);
    return (table?.keys() ?? []).map((name) => {
      const held = table!.lookup(name);
      return String((held instanceof PDFStream ? held.dict : (held as PDFDict)).get(N(key)));
    });
  };
  const contents = dict.lookup(N('Contents'));
  return {
    count: stamps.length,
    rect: dict.lookup(N('Rect'), PDFArray).asArray().map(Number),
    contents: contents instanceof PDFString || contents instanceof PDFHexString ? contents.decodeText() : '',
    content: normal instanceof PDFRawStream ? latin1(decodePDFRawStream(normal).decode()) : '',
    xobjects: entries('XObject', 'Subtype'),
    fonts: entries('Font', 'BaseFont'),
    dict,
  };
}

/** The operators pdf.js emits for a page with its annotation appearances. */
async function drawn(bytes: Uint8Array, pageNumber = 1): Promise<Set<number>> {
  const pdf = await loadPdf(bytes);
  const list = await (await pdf.getPage(pageNumber)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
  await pdf.loadingTask.destroy();
  return new Set(list.fnArray);
}

async function expectImageStamp(bytes: Uint8Array, contents = 'Scanned'): Promise<StampReading> {
  const reading = stampOf(await PDFDocument.load(bytes));
  expect({ count: reading.count, contents: reading.contents, xobjects: reading.xobjects })
    .toEqual({ count: 1, contents, xobjects: ['/Image'] });
  expect(reading.content).toContain('Do');
  expect((await drawn(bytes)).has(pdfjs.OPS.paintImageXObject)).toBe(true);
  expect((await expectSound(bytes)).used.images).toBe(1);
  return reading;
}

describe('an image stamp after the file is read back', () => {
  const placed = async () => commit(await blankPage(), placing(IMAGE_STAMP));

  it('is read back as a stamp with no image of its own', async () => {
    const [page] = await importedPages(await placed());
    expect(page.annotations).toHaveLength(1);
    expect(page.annotations![0]).toMatchObject({ kind: 'stamp', note: 'Scanned' });
    expect(page.annotations![0].imageData).toBeUndefined();
  });

  it('still paints its image after a commit of another edit on its page, and after a third commit', async () => {
    const once = await placed();
    const before = await expectImageStamp(once);
    const twice = await commit(once, otherEdit);
    const after = await expectImageStamp(twice);
    expect(after.rect).toEqual(before.rect);
    expect(after.content).toBe(before.content);
    await expectImageStamp(await commit(twice));
  });

  it('moves with its image', async () => {
    const once = await placed();
    const before = stampOf(await PDFDocument.load(once));
    const twice = await commit(once, editStamp((stamp) => ({ ...stamp, x: stamp.x + 0.1, y: stamp.y + 0.2 })));
    const after = await expectImageStamp(twice);
    expect(after.rect[0]).toBeCloseTo(before.rect[0] + 30, 3);
    expect(after.rect[1]).toBeCloseTo(before.rect[1] - 120, 3);
    expect(after.rect[2] - after.rect[0]).toBeCloseTo(before.rect[2] - before.rect[0], 3);
    await expectImageStamp(await commit(twice));
  });

  it('resizes with its image', async () => {
    const once = await placed();
    const twice = await commit(once, editStamp((stamp) => ({ ...stamp, w: stamp.w * 2, h: stamp.h * 1.5 })));
    const after = await expectImageStamp(twice);
    expect(after.rect[2] - after.rect[0]).toBeCloseTo(180, 3);
    expect(after.rect[3] - after.rect[1]).toBeCloseTo(90, 3);
  });

  it('keeps its image and its rectangle when its page is turned', async () => {
    const once = await placed();
    const before = stampOf(await PDFDocument.load(once));
    const twice = await commit(once, ([page]) => [{ ...page, rotation: 90, annotations: page.annotations!.map((a) => rotateAnnotationRect(a, 90)) }]);
    const doc = await PDFDocument.load(twice);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    const after = await expectImageStamp(twice);
    after.rect.forEach((value, index) => expect(value).toBeCloseTo(before.rect[index], 3));
    await expectImageStamp(await commit(twice, otherEdit));
  });

  it('keeps its image when its text changes, and takes the new text', async () => {
    const twice = await commit(await placed(), editStamp((stamp) => ({ ...stamp, note: 'Received' })));
    await expectImageStamp(twice, 'Received');
  });

  it('leaves the file with its image when the user deletes it', async () => {
    const twice = await commit(await placed(), ([page]) => [deleting(page, (a) => a.kind === 'stamp')]);
    expect(stampOf(await PDFDocument.load(twice)).count).toBe(0);
    expect((await expectSound(twice, ['Scanned'])).used.images).toBe(0);
    expect((await drawn(twice)).has(pdfjs.OPS.paintImageXObject)).toBe(false);
  });

  it('keeps its image in a collection file', async () => {
    const once = await commit(await blankPage(), placing(IMAGE_STAMP), 'a.pdfx');
    await expectImageStamp(await commit(once, otherEdit, 'a.pdfx'));
  });
});

describe.skipIf(!HAS_FACES)('a typed signature after the file is read back', () => {
  const placed = async () => commit(await blankPage(), placing(TYPED_SIGNATURE));

  async function expectSignature(bytes: Uint8Array): Promise<StampReading> {
    const reading = stampOf(await PDFDocument.load(bytes));
    expect({ count: reading.count, contents: reading.contents }).toEqual({ count: 1, contents: 'Ada Lovelace' });
    expect(reading.fonts).toHaveLength(1);
    expect(reading.fonts[0]).toContain('GreatVibes');
    expect(reading.content).toContain('Tf');
    expect((await expectSound(bytes)).used.embedded_fonts).toBe(1);
    expect((await drawn(bytes)).has(pdfjs.OPS.showText)).toBe(true);
    return reading;
  }

  it('is read back with its face, and is set in it again by the next commits', async () => {
    const once = await placed();
    await expectSignature(once);
    const [page] = await importedPages(once);
    expect(page.annotations![0]).toMatchObject({ kind: 'stamp', note: 'Ada Lovelace', signatureFont: 'greatvibes' });
    const twice = await commit(once, otherEdit);
    await expectSignature(twice);
    await expectSignature(await commit(twice));
  });

  it('takes a new colour and a new place in its face', async () => {
    const twice = await commit(await placed(), editStamp((stamp) => ({ ...stamp, color: '#ff0000', x: stamp.x + 0.1 })));
    const reading = await expectSignature(twice);
    expect(reading.content).toContain('1 0 0 rg');
  });

  it('written without its face name keeps the appearance it has', async () => {
    const doc = await PDFDocument.load(await placed());
    annotsOf(doc)[0].dict.delete(N('SpectraSignatureFont'));
    const unnamed = await doc.save();
    const [page] = await importedPages(unnamed);
    expect(page.annotations![0].signatureFont).toBeUndefined();
    const before = await expectSignature(unnamed);
    const twice = await commit(unnamed, otherEdit);
    const after = await expectSignature(twice);
    expect(after.content).toBe(before.content);
    await expectSignature(await commit(twice, editStamp((stamp) => ({ ...stamp, y: stamp.y + 0.1 }))));
  });

  it('whose face this build does not hold keeps the appearance it has', async () => {
    const doc = await PDFDocument.load(await placed());
    annotsOf(doc)[0].dict.set(N('SpectraSignatureFont'), N('nosuchface'));
    await expectSignature(await commit(await doc.save(), otherEdit));
  });
});

describe('a stamp of another producer', () => {
  /** A stamp with an image appearance, a second appearance state and entries
   *  the import does not read. */
  async function foreign(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    const ctx = doc.context;
    const image = ctx.register(ctx.stream(String.fromCharCode(255, 0, 0, 0, 255, 0), {
      Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    }));
    const form = (name: string) => ctx.register(ctx.stream(`q 90 0 0 40 0 0 cm /${name} Do Q`, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 90, 40], Resources: { XObject: { [name]: image } },
    }));
    const stamp = ctx.obj({
      Type: 'Annot', Subtype: 'Stamp', Rect: [60, 300, 150, 340], F: 4, Name: 'Approved', CA: 0.5,
      AP: { N: form('Normal'), D: form('Down') },
    });
    stamp.set(N('Contents'), PDFString.of('FOREIGNSTAMP'));
    stamp.set(N('NM'), PDFString.of('stamp-name'));
    stamp.set(N('T'), PDFString.of('Reviewer'));
    stamp.set(N('M'), PDFString.of('D:20240102030405Z'));
    page.node.set(N('Annots'), ctx.obj([ctx.register(stamp)]));
    return doc.save();
  }

  const entriesOf = (reading: StampReading): Record<string, string> => Object.fromEntries(
    ['Name', 'NM', 'T', 'M', 'CA', 'F', 'C'].map((key) => {
      const value = reading.dict.lookup(N(key));
      return [key, value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : String(value)];
    }));

  it('keeps its appearances and every entry through a commit of another edit', async () => {
    const source = await foreign();
    const before = stampOf(await PDFDocument.load(source));
    const twice = await commit(await commit(source, otherEdit));
    const after = stampOf(await PDFDocument.load(twice));
    expect(after.count).toBe(1);
    expect(after.content).toBe(before.content);
    expect(after.rect).toEqual(before.rect);
    expect(entriesOf(after)).toEqual(entriesOf(before));
    expect(entriesOf(after)).toMatchObject({ Name: '/Approved', NM: 'stamp-name', T: 'Reviewer', CA: '0.5', C: 'undefined' });
    expect(after.dict.lookup(N('AP'), PDFDict).keys().map(String).sort()).toEqual(['/D', '/N']);
    expect((await drawn(twice)).has(pdfjs.OPS.paintImageXObject)).toBe(true);
    await expectSound(twice);
  });

  it('moves, takes a new colour and a new text, and keeps its appearance', async () => {
    const source = await foreign();
    const before = stampOf(await PDFDocument.load(source));
    const twice = await commit(source, editStamp((stamp) => ({ ...stamp, x: stamp.x + 0.1, color: '#ff0000', note: 'CHANGED' })));
    const after = stampOf(await PDFDocument.load(twice));
    expect(after.content).toBe(before.content);
    expect(after.rect[0]).toBeCloseTo(before.rect[0] + 30, 3);
    expect(after.contents).toBe('CHANGED');
    expect(entriesOf(after)).toMatchObject({ Name: '/Approved', NM: 'stamp-name', T: 'Reviewer', C: '[ 1 0 0 ]' });
    await expectSound(twice, ['FOREIGNSTAMP']);
  });
});

describe('a label stamp after the file is read back', () => {
  const LABEL: Omit<PageAnnotation, 'id'> = { kind: 'stamp', x: 0.2, y: 0.4, w: 0.4, h: 0.08, color: '#2fbf71', note: 'APPROVED' };

  it('is drawn again as a label, with a new text when the user changes it', async () => {
    const once = await commit(await blankPage(), placing(LABEL));
    expect(stampOf(await PDFDocument.load(once)).content).toContain('(APPROVED) Tj');
    const same = await commit(once, otherEdit);
    expect(stampOf(await PDFDocument.load(same)).content).toContain('(APPROVED) Tj');
    const twice = await commit(once, editStamp((stamp) => ({ ...stamp, note: 'REJECTED', color: '#ff0000' })));
    const reading = stampOf(await PDFDocument.load(twice));
    expect(reading.content).toContain('(REJECTED) Tj');
    expect(reading.content).toContain('1 0 0 rg');
    expect(reading.contents).toBe('REJECTED');
    await expectSound(twice, ['APPROVED']);
  });
});
