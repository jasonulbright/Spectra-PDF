// The font a /DA names is an entry of /AcroForm /DR /Font (ISO 32000-2
// 12.7.4.3), and one name is one font. A free text annotation, or a redaction
// with overlay text (12.5.6.23, Table 195), that travels into a document
// which holds another font under its name keeps its own font under a new
// name; fonts that are interchangeable, or one object, share the name.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import type { ExportAnnotation, ExportPage } from '../src/renderer/lib/pdfx-format';
import { buildPdf } from '../src/renderer/lib/pdfx-build';
import { completeAnnotationDefaultResources, FontComparison, interchangeableFontKey, rewriteDaFonts, sameSubsetFont } from '../src/renderer/lib/annotation-default-resources';
import { docCarriesLiveSignature } from '../src/renderer/lib/signature-presence';
import { sourceHasXfa } from '../src/renderer/lib/acroform-carry';
import { commit, deleting } from './support/commit-cycle';
import { expectSound, loadPdf } from './support/saved-pdf';
import { testPython } from './support/python';

const N = PDFName.of;
const PYTHON_RUNS = 30_000;

type Face =
  | { base: string; encoding?: string }
  /** A font with a font program: interchangeable with no other. */
  | { embedded: string };

interface Annotation {
  subtype: 'FreeText' | 'Redact';
  /** The default appearance string. */
  da: string;
  overlay?: boolean;
}

interface Fixture {
  /** Font resource name → face, in /AcroForm /DR /Font. */
  fonts: Record<string, Face>;
  annotations: Annotation[];
  /** A text field whose /DA names this font. */
  field?: string;
  pages?: number;
}

/** A document whose pages each hold `annotations`. The free text annotations
 *  are callouts with a line ending the import does not author, so a commit
 *  leaves them as written. */
async function fixture({ fonts, annotations, field, pages = 1 }: Fixture): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const table = doc.context.obj({});
  for (const [name, face] of Object.entries(fonts)) {
    const font = 'embedded' in face
      ? doc.context.obj({
          Type: 'Font', Subtype: 'TrueType', BaseFont: face.embedded,
          FontDescriptor: doc.context.register(doc.context.obj({ Type: 'FontDescriptor', FontName: face.embedded, Flags: 32 })),
        })
      : doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: face.base, ...(face.encoding ? { Encoding: face.encoding } : {}) });
    table.set(N(name), doc.context.register(font));
  }
  const shown = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier' }));
  const roots: PDFObject[] = [];
  for (let index = 0; index < pages; index++) {
    const page = doc.addPage([300, 600]);
    const entries: PDFObject[] = [];
    annotations.forEach((spec, slot) => {
      const appearance = doc.context.register(doc.context.stream('BT /F0 10 Tf 2 5 Td (Text) Tj ET', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20], Resources: { Font: { F0: shown } },
      }));
      const y = 500 - slot * 40;
      const annotation = doc.context.obj({ Type: 'Annot', Subtype: spec.subtype, Rect: [50, y, 150, y + 20], F: 4, AP: { N: appearance } });
      annotation.set(N('DA'), PDFString.of(spec.da));
      if (spec.subtype === 'FreeText') {
        annotation.set(N('Contents'), PDFString.of('Carried'));
        annotation.set(N('IT'), N('FreeTextCallout'));
        annotation.set(N('CL'), doc.context.obj([20, y - 20, 40, y, 50, y + 10]));
        annotation.set(N('LE'), N('Diamond'));
      } else if (spec.overlay !== false) {
        annotation.set(N('OverlayText'), PDFString.of('REDACTED'));
      }
      entries.push(doc.context.register(annotation));
    });
    if (field !== undefined && index === 0) {
      const widget = doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Tx', Rect: [50, 100, 200, 120], F: 4, P: page.ref,
      });
      widget.set(N('T'), PDFString.of('name'));
      widget.set(N('DA'), PDFString.of(`/${field} 10 Tf 0 g`));
      const ref = doc.context.register(widget);
      entries.push(ref);
      roots.push(ref);
    }
    page.node.set(N('Annots'), doc.context.obj(entries));
  }
  doc.catalog.set(N('AcroForm'), doc.context.register(doc.context.obj({ Fields: roots, DR: { Font: table } })));
  return doc.save();
}

const pagesOf = (bytes: Uint8Array, sourceKey: string, indices: number[] = [0], annotations?: ExportAnnotation[]): ExportPage[] =>
  indices.map((pageIndex) => ({ bytes, sourceKey, pageIndex, ...(annotations ? { annotations } : {}) }));

interface Reading {
  /** Font resource name → base font, with `*` after a font that has a program. */
  fonts: Record<string, string>;
  /** Per page, the /DA of each free text and redaction annotation and of each field widget. */
  appearances: string[][];
  fields: number;
}

async function reading(bytes: Uint8Array): Promise<Reading> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = doc.catalog.lookup(N('AcroForm'));
  const table = form instanceof PDFDict ? form.lookupMaybe(N('DR'), PDFDict)?.lookupMaybe(N('Font'), PDFDict) : undefined;
  const fonts: Record<string, string> = {};
  for (const name of table?.keys() ?? []) {
    const font = table!.lookup(name, PDFDict);
    fonts[name.decodeText()] = `${font.get(N('BaseFont'))!.toString().slice(1)}${font.has(N('FontDescriptor')) ? '*' : ''}`;
  }
  const appearances = doc.getPages().map((page) => {
    const annots = page.node.lookup(N('Annots'));
    const out: string[] = [];
    if (annots instanceof PDFArray) {
      for (let i = 0; i < annots.size(); i++) {
        const text = annots.lookup(i, PDFDict).lookup(N('DA'));
        if (text instanceof PDFString || text instanceof PDFHexString) out.push(String.fromCharCode(...text.asBytes()));
      }
    }
    return out;
  });
  return { fonts, appearances, fields: form instanceof PDFDict ? form.lookupMaybe(N('Fields'), PDFArray)?.size() ?? 0 : 0 };
}

const FREE_TEXT: Annotation = { subtype: 'FreeText', da: '0 g /Helv 10 Tf' };
const TIMES: Face = { base: 'Times-Roman' };
const COURIER: Face = { base: 'Courier' };
const TEXT_BOX: ExportAnnotation = { kind: 'freetext', x: 0.1, y: 0.1, w: 0.4, h: 0.05, color: '#14213d', note: 'Text box' };

describe('the rule that makes two default resource fonts one', () => {
  it('accepts simple fonts with no program whose subtype, base font and encoding name agree', async () => {
    const doc = await PDFDocument.create();
    const key = (font: Record<string, unknown>): string | null => interchangeableFontKey(doc, doc.context.obj(font as never));
    const helvetica = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' };
    expect(key(helvetica)).toBe('/Type1 /Helvetica /WinAnsiEncoding');
    expect(key({ ...helvetica })).toBe(key(helvetica));
    expect(interchangeableFontKey(doc, doc.context.register(doc.context.obj(helvetica)))).toBe(key(helvetica));
    expect(key({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })).toBe('/Type1 /Helvetica ');
    expect(key({ ...helvetica, Encoding: 'MacRomanEncoding' })).not.toBe(key(helvetica));
    // A dictionary encoding, a font program, a composite font and a
    // non-font are interchangeable with nothing.
    expect(key({ ...helvetica, Encoding: { Type: 'Encoding', Differences: [65, 'B'] } })).toBeNull();
    expect(key({ ...helvetica, FontDescriptor: { Type: 'FontDescriptor' } })).toBeNull();
    expect(key({ Type: 'Font', Subtype: 'Type0', BaseFont: 'Helvetica' })).toBeNull();
    expect(key({ Type: 'Font', Subtype: 'Type3' })).toBeNull();
    expect(interchangeableFontKey(doc, PDFRef.of(9999))).toBeNull();
  });

  it('rewrites every renamed name of a default appearance string in one pass', () => {
    expect(rewriteDaFonts('/Helv 10 Tf /Helv_1 8 Tf /HelvB 9 Tf', new Map([['Helv', 'Helv_1'], ['Helv_1', 'Helv_1_1']])))
      .toBe('/Helv_1 10 Tf /Helv_1_1 8 Tf /HelvB 9 Tf');
  });
});

describe('appearance streams that select default-resource fonts', () => {
  it('treats a plus in the resource name literally', async () => {
    const output = await PDFDocument.create();
    const page = output.addPage([300, 600]);
    const fontTable = output.context.obj({});
    const font = output.context.register(output.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier' }));
    fontTable.set(N('A+B'), font);
    const resources = output.context.obj({});
    resources.set(N('Font'), fontTable);
    const form = output.context.obj({ Fields: [] });
    form.set(N('DR'), resources);
    output.catalog.set(N('AcroForm'), output.context.register(form));

    const appearance = output.context.stream('BT /A+B 10 Tf ET', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20],
    });
    const annotation = output.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [0, 0, 100, 20] });
    const appearances = output.context.obj({});
    appearances.set(N('N'), appearance);
    annotation.set(N('AP'), appearances);
    page.node.set(N('Annots'), output.context.obj([annotation]));

    const original = output.context.obj({});
    original.set(N('DA'), PDFString.of('/A+B 10 Tf'));
    completeAnnotationDefaultResources(output, [{ source: output, copiedPages: [page] }], {
      released: () => true,
      redrawn: new Map([[page, [original]]]),
    });

    expect(fontTable.has(N('A+B'))).toBe(true);
  });
});

describe('a merge of documents that hold different fonts under one name', () => {
  it.each<[string, string | undefined, string | undefined]>([
    ['neither form has a field', undefined, undefined],
    ['both forms have a field', 'Helv', 'Helv'],
    ['the first form has a field', 'Helv', undefined],
    ['the second form has a field', undefined, 'Helv'],
  ])('gives the second document its font under a new name: %s', async (_label, firstField, secondField) => {
    const first = await fixture({ fonts: { Helv: TIMES }, annotations: [FREE_TEXT], field: firstField });
    const second = await fixture({ fonts: { Helv: COURIER }, annotations: [FREE_TEXT], field: secondField });
    const merged = await buildPdf([...pagesOf(first, 'first'), ...pagesOf(second, 'second')], first, 'first');
    await expectSound(merged);
    const { fonts, appearances } = await reading(merged);
    // The order of the two names follows which form the carry reads first;
    // each document keeps its own font.
    const nameOf = (base: string): string => Object.keys(fonts).find((name) => fonts[name] === base)!;
    expect(Object.values(fonts).sort()).toEqual(['Courier', 'Times-Roman']);
    expect(Object.keys(fonts).sort()).toEqual(['Helv', 'Helv_1']);
    expect(appearances[0]).toEqual([`0 g /${nameOf('Times-Roman')} 10 Tf`, ...(firstField ? [`/${nameOf('Times-Roman')} 10 Tf 0 g`] : [])]);
    expect(appearances[1]).toEqual([`0 g /${nameOf('Courier')} 10 Tf`, ...(secondField ? [`/${nameOf('Courier')} 10 Tf 0 g`] : [])]);
  }, PYTHON_RUNS);

  it('shares the name when both documents hold an interchangeable font under it', async () => {
    const standard: Face = { base: 'Helvetica', encoding: 'WinAnsiEncoding' };
    const first = await fixture({ fonts: { Helv: standard }, annotations: [FREE_TEXT] });
    const second = await fixture({ fonts: { Helv: standard }, annotations: [FREE_TEXT] });
    const merged = await buildPdf([...pagesOf(first, 'first'), ...pagesOf(second, 'second')], first, 'first');
    await expectSound(merged);
    expect(await reading(merged)).toMatchObject({ fonts: { Helv: 'Helvetica' }, appearances: [['0 g /Helv 10 Tf'], ['0 g /Helv 10 Tf']] });
  });

  it('keeps fonts with a font program apart, and one such font under one name for every copy of its document', async () => {
    const first = await fixture({ fonts: { Helv: { embedded: 'ABCDEF+Sans' } }, annotations: [FREE_TEXT], pages: 2 });
    const second = await fixture({ fonts: { Helv: { embedded: 'ABCDEF+Sans' } }, annotations: [FREE_TEXT] });
    // The first document's page twice (a duplicate page), its other page, and the second document's page.
    const merged = await buildPdf([...pagesOf(first, 'first', [0, 0, 1]), ...pagesOf(second, 'second')], first, 'first');
    await expectSound(merged);
    expect(await reading(merged)).toMatchObject({
      fonts: { Helv: 'ABCDEF+Sans*', Helv_1: 'ABCDEF+Sans*' },
      appearances: [['0 g /Helv 10 Tf'], ['0 g /Helv 10 Tf'], ['0 g /Helv 10 Tf'], ['0 g /Helv_1 10 Tf']],
    });
  });

  it('renames each name of the second document once when a new name is itself one of its names', async () => {
    const first = await fixture({ fonts: { Helv: TIMES }, annotations: [FREE_TEXT] });
    const second = await fixture({
      fonts: { Helv: COURIER, Helv_1: { base: 'Symbol' } },
      annotations: [{ subtype: 'FreeText', da: '0 g /Helv 10 Tf' }, { subtype: 'FreeText', da: '0 g /Helv_1 8 Tf' }],
    });
    const merged = await buildPdf([...pagesOf(first, 'first'), ...pagesOf(second, 'second')], first, 'first');
    await expectSound(merged);
    expect(await reading(merged)).toMatchObject({
      fonts: { Helv: 'Times-Roman', Helv_1: 'Courier', Helv_1_1: 'Symbol' },
      appearances: [['0 g /Helv 10 Tf'], ['0 g /Helv_1 10 Tf', '0 g /Helv_1_1 8 Tf']],
    });
  });

  it('leaves a name as written when its own document holds no font under it', async () => {
    const first = await fixture({ fonts: { F7: TIMES }, annotations: [{ subtype: 'FreeText', da: '0 g /F7 10 Tf' }] });
    const second = await fixture({ fonts: {}, annotations: [{ subtype: 'FreeText', da: '0 g /F7 10 Tf' }] });
    const merged = await buildPdf([...pagesOf(first, 'first'), ...pagesOf(second, 'second')], first, 'first');
    expect(await reading(merged)).toMatchObject({ fonts: { F7: 'Times-Roman' }, appearances: [['0 g /F7 10 Tf'], ['0 g /F7 10 Tf']] });
  });
});

describe('four documents that hold four fonts under one name, in every order', () => {
  const FACES: Record<string, Face> = {
    a: TIMES, b: COURIER, c: { embedded: 'ABCDEF+Sans' }, d: { base: 'Symbol' },
  };
  const FIELD: Record<string, string | undefined> = { a: undefined, b: 'Helv', c: undefined, d: 'Helv' };
  const TEXTS: Record<string, Annotation[]> = { a: [FREE_TEXT], b: [FREE_TEXT], c: [FREE_TEXT, { subtype: 'Redact', da: '0 g /Helv 10 Tf' }], d: [] };
  const baseOf = (face: Face): string => ('embedded' in face ? `${face.embedded}*` : face.base);
  const orders = (tags: string[]): string[][] => tags.length <= 1 ? [tags]
    : tags.flatMap((tag, i) => orders([...tags.slice(0, i), ...tags.slice(i + 1)]).map((rest) => [tag, ...rest]));

  /** Each page's /DA strings select the font of the page's own document. */
  function expectOwnFonts(order: string[], { fonts, appearances }: Reading, label: string): void {
    expect(Object.values(fonts).sort(), label).toEqual(Object.values(FACES).map(baseOf).sort());
    order.forEach((tag, page) => {
      expect(appearances[page].length, label).toBe(TEXTS[tag].length + (FIELD[tag] ? 1 : 0));
      for (const text of appearances[page]) {
        const name = /\/(\S+) 10 Tf/.exec(text)![1];
        expect(fonts[name], `${label} page ${page + 1} ${text}`).toBe(baseOf(FACES[tag]));
      }
    });
  }

  it('keeps every default appearance on its own font, in the build and in the engine merge', async () => {
    const sources: Record<string, Uint8Array> = {};
    for (const tag of Object.keys(FACES)) {
      sources[tag] = await fixture({ fonts: { Helv: FACES[tag] }, annotations: TEXTS[tag], field: FIELD[tag] });
    }
    const dir = mkdtempSync(join(tmpdir(), 'spectra-font-names-'));
    try {
      for (const [tag, bytes] of Object.entries(sources)) writeFileSync(join(dir, `${tag}.pdf`), bytes);
      const all = orders(Object.keys(FACES));
      expect(all.length).toBe(24);
      execFileSync(testPython(), ['-B', '-c', [
        'import os, sys',
        'from engine.merge import merge',
        'folder = sys.argv[1]',
        'for order in sys.argv[2:]:',
        '    merge([os.path.join(folder, tag + ".pdf") for tag in order], os.path.join(folder, "engine-" + order + ".pdf"))',
      ].join('\n'), dir, ...all.map((order) => order.join(''))], { env: { ...process.env, PYTHONPATH: join(__dirname, '..', 'src') }, windowsHide: true });
      for (const order of all) {
        const label = order.join('');
        const built = await buildPdf(order.flatMap((tag) => pagesOf(sources[tag], tag)), sources[order[0]], order[0]);
        expectOwnFonts(order, await reading(built), `build ${label}`);
        expectOwnFonts(order, await reading(new Uint8Array(readFileSync(join(dir, `engine-${label}.pdf`)))), `engine ${label}`);
      }
      const sample = await buildPdf(['d', 'c', 'b', 'a'].flatMap((tag) => pagesOf(sources[tag], tag)), sources.d, 'd');
      await expectSound(sample);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});

describe('a page moved into another document', () => {
  it('keeps its font under a new name, and a further commit of the result changes nothing', async () => {
    const owner = await fixture({ fonts: { Helv: TIMES }, annotations: [FREE_TEXT], pages: 2 });
    const donor = await fixture({ fonts: { Helv: COURIER }, annotations: [FREE_TEXT] });
    const moved = await buildPdf([...pagesOf(owner, 'owner', [0]), ...pagesOf(donor, 'donor'), ...pagesOf(owner, 'owner', [1])], owner, 'owner');
    await expectSound(moved);
    const after = await reading(moved);
    expect(after).toMatchObject({
      fonts: { Helv: 'Times-Roman', Helv_1: 'Courier' },
      appearances: [['0 g /Helv 10 Tf'], ['0 g /Helv_1 10 Tf'], ['0 g /Helv 10 Tf']],
    });
    const again = await buildPdf(pagesOf(moved, 'moved', [0, 1, 2]), moved, 'moved');
    await expectSound(again);
    expect(await reading(again)).toEqual(after);
    // The moved page duplicated and taken back out to a third document.
    const out = await buildPdf(pagesOf(moved, 'moved', [1, 1]), moved, 'moved');
    expect(await reading(out)).toMatchObject({ appearances: [['0 g /Helv_1 10 Tf'], ['0 g /Helv_1 10 Tf']] });
    expect((await reading(out)).fonts.Helv_1).toBe('Courier');
  }, PYTHON_RUNS);
});

describe('a text box written on a document that holds another font under Helv', () => {
  it('names the standard face under a name of its own, and the next text box takes the same name', async () => {
    const source = await fixture({ fonts: { Helv: TIMES }, annotations: [FREE_TEXT] });
    const once = await buildPdf(pagesOf(source, 'a', [0], [TEXT_BOX]), source, 'a');
    await expectSound(once);
    const first = await reading(once);
    expect(first.fonts).toEqual({ Helv: 'Times-Roman', Helv_1: 'Helvetica' });
    expect(first.appearances[0][0]).toBe('0 g /Helv 10 Tf');
    expect(first.appearances[0][1]).toMatch(/ rg \/Helv_1 [\d.]+ Tf$/);
    const twice = await buildPdf(pagesOf(once, 'b', [0], [{ ...TEXT_BOX, y: 0.3 }]), once, 'b');
    await expectSound(twice);
    const second = await reading(twice);
    expect(second.fonts).toEqual(first.fonts);
    expect(second.appearances[0].filter((text) => / \/Helv_1 /.test(text)).length).toBe(2);
  }, PYTHON_RUNS);

  it('takes Helv itself when the document holds the standard face under it, with or without a field', async () => {
    for (const field of [undefined, 'Helv']) {
      const source = await fixture({ fonts: { Helv: { base: 'Helvetica', encoding: 'WinAnsiEncoding' } }, annotations: [], field });
      const once = await buildPdf(pagesOf(source, 'a', [0], [TEXT_BOX]), source, 'a');
      await expectSound(once);
      expect((await reading(once)).fonts).toEqual({ Helv: 'Helvetica' });
    }
  });
});

describe('a redaction annotation with overlay text', () => {
  const REDACTION: Annotation = { subtype: 'Redact', da: '/Helv 12 Tf 1 1 1 rg' };

  it('keeps its font under a new name in a document that holds another font under the name', async () => {
    const first = await fixture({ fonts: { Helv: TIMES }, annotations: [REDACTION] });
    const second = await fixture({ fonts: { Helv: COURIER }, annotations: [REDACTION, FREE_TEXT] });
    const merged = await buildPdf([...pagesOf(first, 'first'), ...pagesOf(second, 'second')], first, 'first');
    const sound = await expectSound(merged);
    expect(sound.used.form_fonts).toBe(3);
    expect(await reading(merged)).toMatchObject({
      fonts: { Helv: 'Times-Roman', Helv_1: 'Courier' },
      appearances: [['/Helv 12 Tf 1 1 1 rg'], ['/Helv_1 12 Tf 1 1 1 rg', '0 g /Helv_1 10 Tf']],
    });
  });

  it('gets the entry its document held when the commit leaves no field in the form', async () => {
    const source = await fixture({ fonts: { Helv: COURIER }, annotations: [REDACTION] });
    const once = await buildPdf(pagesOf(source, 'a'), source, 'a');
    await expectSound(once);
    expect(await reading(once)).toMatchObject({ fonts: { Helv: 'Courier' }, appearances: [['/Helv 12 Tf 1 1 1 rg']], fields: 0 });
  });

  it('is not read for a font when it has no overlay text', async () => {
    const first = await fixture({ fonts: { Helv: TIMES }, annotations: [FREE_TEXT] });
    const second = await fixture({ fonts: { Helv: COURIER }, annotations: [{ ...REDACTION, overlay: false }] });
    const merged = await buildPdf([...pagesOf(first, 'first'), ...pagesOf(second, 'second')], first, 'first');
    expect(await reading(merged)).toMatchObject({ fonts: { Helv: 'Times-Roman' }, appearances: [['0 g /Helv 10 Tf'], ['/Helv 12 Tf 1 1 1 rg']] });
  });
});

describe('a form dictionary that only holds the font of a text box', () => {
  it('gives the document no form, no signature and no script in any reader of the renderer', async () => {
    const blank = await PDFDocument.create();
    blank.addPage([300, 600]);
    const source = await blank.save();
    const once = await buildPdf(pagesOf(source, 'a', [0], [TEXT_BOX]), source, 'a');
    const doc = await PDFDocument.load(once, { updateMetadata: false });
    const form = doc.catalog.lookup(N('AcroForm'), PDFDict);
    // ISO 32000-2 Table 224: /Fields is the one required entry.
    expect(form.lookup(N('Fields'), PDFArray).size()).toBe(0);
    expect(form.keys().map((key) => key.decodeText()).sort()).toEqual(['DR', 'Fields']);
    expect(docCarriesLiveSignature(doc)).toBe(false);
    expect(sourceHasXfa(doc)).toBe(false);
    const plain = await PDFDocument.load(source, { updateMetadata: false });
    expect(docCarriesLiveSignature(plain)).toBe(false);

    const pdf = await loadPdf(once);
    const before = await loadPdf(source);
    try {
      expect([await pdf.getFieldObjects(), await pdf.hasJSActions(), pdf.isPureXfa, await pdf.getCalculationOrderIds()])
        .toEqual([await before.getFieldObjects(), await before.hasJSActions(), before.isPureXfa, await before.getCalculationOrderIds()]);
      expect([await pdf.getFieldObjects(), await pdf.hasJSActions(), pdf.isPureXfa]).toEqual([null, false, false]);
      const info = (await pdf.getMetadata()).info as { IsAcroFormPresent?: boolean; IsXFAPresent?: boolean; IsSignaturesPresent?: boolean };
      expect([info.IsAcroFormPresent, info.IsXFAPresent, info.IsSignaturesPresent]).toEqual([false, false, false]);
    } finally {
      await pdf.loadingTask.destroy();
      await before.loadingTask.destroy();
    }
    // The text box deleted: the form dictionary goes with its last use.
    const again = await commit(once, ([page, ...rest]) => [deleting(page, () => true), ...rest]);
    expect((await PDFDocument.load(again, { updateMetadata: false })).catalog.has(N('AcroForm'))).toBe(false);
  });
});

describe('a font name whose bytes are not UTF-8', () => {
  // `/F#E9` as pdf-lib decodes it: the letter and the byte E9.
  const NAME = `F${String.fromCharCode(0xe9)}`;
  const TOKENS: [string, string][] = [['its escape', 'F#E9'], ['its byte', NAME]];

  it('is one name whether a default appearance writes the escape or the byte', () => {
    expect(rewriteDaFonts(`/F#E9 10 Tf /${NAME} 8 Tf /F#E9x 9 Tf /F#e9 7 Tf`, new Map([[NAME, `${NAME}_1`]])))
      .toBe('/F#E9_1 10 Tf /F#E9_1 8 Tf /F#E9x 9 Tf /F#e9 7 Tf');
    // A string with no renamed name is returned as written, whatever its tokens.
    for (const written of ['/F#E9 10 Tf', `/${NAME} 10 Tf`, '/F# 10 Tf /#ZZ 1 Tf /# 2 Tf', '/ 1 Tf //']) {
      expect(rewriteDaFonts(written, new Map([['Helv', 'Helv_1']]))).toBe(written);
    }
  });

  it.each(TOKENS)('stays as written through a build that carries it, written as %s', async (_label, token) => {
    const source = await fixture({ fonts: { 'F#E9': TIMES }, annotations: [{ subtype: 'FreeText', da: `0 g /${token} 10 Tf` }], field: token });
    const built = await buildPdf(pagesOf(source, 'first'), source, 'first');
    await expectSound(built);
    const { fonts, appearances } = await reading(built);
    expect(fonts).toEqual({ [NAME]: 'Times-Roman' });
    expect(appearances[0]).toEqual([`0 g /${token} 10 Tf`, `/${token} 10 Tf 0 g`]);
  }, PYTHON_RUNS);

  it.each(TOKENS)('takes the next name of its family in a merge, written as %s', async (_label, token) => {
    const annotations: Annotation[] = [{ subtype: 'FreeText', da: `0 g /${token} 10 Tf` }];
    const first = await fixture({ fonts: { 'F#E9': TIMES }, annotations, field: token });
    const second = await fixture({ fonts: { 'F#E9': COURIER }, annotations, field: token });
    const merged = await buildPdf([...pagesOf(first, 'first'), ...pagesOf(second, 'second')], first, 'first');
    await expectSound(merged);
    const { fonts, appearances } = await reading(merged);
    expect(Object.keys(fonts).sort()).toEqual([NAME, `${NAME}_1`]);
    expect(Object.values(fonts).sort()).toEqual(['Courier', 'Times-Roman']);
    // The font that keeps the name keeps its strings as written; the other
    // takes the new name, written as pdf-lib writes that name.
    const written = (base: string): string => (fonts[NAME] === base ? token : 'F#E9_1');
    expect(appearances[0]).toEqual([`0 g /${written('Times-Roman')} 10 Tf`, `/${written('Times-Roman')} 10 Tf 0 g`]);
    expect(appearances[1]).toEqual([`0 g /${written('Courier')} 10 Tf`, `/${written('Courier')} 10 Tf 0 g`]);
  }, PYTHON_RUNS);
});

describe('the comparison of subset fonts in one build', () => {
  it('reads each font stream once and answers each pair once', async () => {
    const doc = await PDFDocument.create();
    const context = doc.context;
    const font = (program: number[]): PDFRef => {
      const descriptor = context.register(context.obj({
        Type: 'FontDescriptor', FontName: 'ABCDEF+Face', FontFile2: context.register(context.stream(Uint8Array.from(program))),
      }));
      const descendant = context.register(context.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'ABCDEF+Face', FontDescriptor: descriptor }));
      return context.register(context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+Face', DescendantFonts: [descendant] }));
    };
    const [one, same, other] = [font([1, 2, 3]), font([1, 2, 3]), font([1, 2, 4])];
    const memo = new FontComparison();
    for (let round = 0; round < 6; round++) {
      expect(sameSubsetFont(context, one, same, memo)).toBe(true);
      expect(sameSubsetFont(context, same, one, memo)).toBe(true);
      expect(sameSubsetFont(context, one, other, memo)).toBe(false);
      expect(sameSubsetFont(context, other, same, memo)).toBe(false);
    }
    expect(memo.decodes).toBe(3);
    // With no memo given the answers are the same.
    expect(sameSubsetFont(context, one, same)).toBe(true);
    expect(sameSubsetFont(context, one, other)).toBe(false);
  });
});
