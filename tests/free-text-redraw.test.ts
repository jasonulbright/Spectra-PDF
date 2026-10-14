// An imported free text or callout that an edit draws again shows its text
// as its original did: in the same font object, with that font's own codes
// and advances, at the size, colour, alignment and leading the original
// states. ISO 32000-2 12.5.6.6 Table 177 (/DA, /Q, /RC, /DS), 9.6.2 and
// 9.6.5 (simple fonts, their widths and encodings), 9.7 (composite fonts),
// 9.10 (/ToUnicode and glyph names).

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFArray, PDFContext, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream,
} from 'pdf-lib';
import type { PDFFont, PDFObject } from 'pdf-lib';
import type { PageAnnotation, PageRef } from '../src/renderer/state/types';
import { DINGBATS_GLYPH_LIST, ENCODING_NAMES, GLYPH_LIST } from '../src/renderer/lib/font-encodings';
import { charactersWithoutCode, glyphNameCharacter, parseToUnicode, readFontDrawing } from '../src/renderer/lib/annotation-font';
import type { FontDrawing, FontProgram } from '../src/renderer/lib/annotation-font';
import {
  defaultAppearanceWithColor, needsShaping, originalText, parseRichText, parseTextStyle, planFreeTextRedraw, wrapText,
} from '../src/renderer/lib/free-text-redraw';
import { faceStyleOf } from '../src/renderer/lib/text-box-faces';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit } from './support/commit-cycle';
import { expectSound, latin1, loadPdf } from './support/saved-pdf';

const FONT_DIR = join(__dirname, '..', 'resources', 'fonts');
const face = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FONT_DIR, name)));
// Guarded on the face files themselves: a checkout with no provisioned
// resources holds none, and a stub directory holds none either.
const HAS_FACES = ['LiberationSerif-Regular.ttf', 'LiberationSerif-Italic.ttf', 'LiberationSans-Bold.ttf', 'NotoSansCJKsc-Regular.otf', 'IBMPlexSansArabic-Regular.ttf']
  .every((name) => existsSync(join(FONT_DIR, name)));

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const N = PDFName.of;
const RUN = 60_000;
const require = createRequire(import.meta.url);

const drawingOf = (context: PDFContext, font: PDFObject, open?: (bytes: Uint8Array) => FontProgram): FontDrawing => {
  const reading = readFontDrawing(context, font, open);
  if (!('drawing' in reading)) throw new Error(`unreadable: ${reading.unreadable}`);
  return reading.drawing;
};
const unreadable = (context: PDFContext, font: PDFObject | undefined): string | undefined => {
  const reading = readFontDrawing(context, font);
  return 'unreadable' in reading ? reading.unreadable : undefined;
};

describe('the encoding tables and the glyph list', () => {
  const worker = readFileSync(require.resolve('pdfjs-dist/build/pdf.worker.mjs'), 'utf8');
  const table = (name: string): string => {
    const match = new RegExp(`const ${name} = \\[([^\\]]*)\\];`).exec(worker);
    expect(match, name).not.toBeNull();
    return (JSON.parse(`[${match![1]}]`) as string[]).join(',');
  };
  const list = (name: string): string => {
    const start = worker.indexOf(`const ${name} = getLookupTableFactory(function (t) {`);
    expect(start, name).toBeGreaterThan(0);
    const body = worker.slice(start, worker.indexOf('\n});', start));
    return [...body.matchAll(/t\.([A-Za-z0-9_.]+) = 0x([0-9a-fA-F]+);|t\["([^"]+)"\] = 0x([0-9a-fA-F]+);/g)]
      .map((m) => `${m[1] ?? m[3]}=${parseInt(m[2] ?? m[4], 16).toString(16)}`).join(',');
  };

  it('equal the tables of the installed pdf.js', () => {
    expect(ENCODING_NAMES.StandardEncoding).toBe(table('StandardEncoding'));
    expect(ENCODING_NAMES.MacRomanEncoding).toBe(table('MacRomanEncoding'));
    expect(ENCODING_NAMES.WinAnsiEncoding).toBe(table('WinAnsiEncoding'));
    expect(ENCODING_NAMES.MacExpertEncoding).toBe(table('MacExpertEncoding'));
    expect(ENCODING_NAMES.Symbol).toBe(table('SymbolSetEncoding'));
    expect(ENCODING_NAMES.ZapfDingbats).toBe(table('ZapfDingbatsEncoding'));
    expect(GLYPH_LIST).toBe(list('getGlyphsUnicode'));
    expect(DINGBATS_GLYPH_LIST).toBe(list('getDingbatsGlyphsUnicode'));
    expect(GLYPH_LIST.split(',').length).toBeGreaterThan(4000);
  });

  it('reads a glyph name as its character', () => {
    expect(glyphNameCharacter('A')).toBe('A');
    expect(glyphNameCharacter('Euro')).toBe('€');
    expect(glyphNameCharacter('afii10017')).toBe('А');
    expect(glyphNameCharacter('uni20AC')).toBe('€');
    expect(glyphNameCharacter('uni00410042')).toBe('AB');
    expect(glyphNameCharacter('u1F600')).toBe('\u{1F600}');
    expect(glyphNameCharacter('a.alt')).toBe('a');
    expect(glyphNameCharacter('a1', true)).toBe('✁');
    expect(glyphNameCharacter('g123')).toBeUndefined();
    expect(glyphNameCharacter('.notdef')).toBeUndefined();
  });
});

describe('what a simple font draws', () => {
  const context = PDFContext.create();
  const font = (entries: Record<string, unknown>): PDFObject => context.register(context.obj({ Type: 'Font', Subtype: 'Type1', ...entries } as never));

  it('gives a standard font the codes of its encoding and the advances of its metrics', () => {
    const helvetica = drawingOf(context, font({ BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
    expect(helvetica.codeBytes).toBe(1);
    expect(helvetica.codeOf('A')).toBe(0x41);
    expect(helvetica.widthOf(0x41)).toBe(667);
    expect(helvetica.codeOf('€')).toBe(0x80);
    expect(helvetica.widthOf(0x80)).toBe(556);
    expect(helvetica.codeOf('•')).toBe(0x95);
    expect(helvetica.codeOf(' ')).toBe(0x20);
    expect(helvetica.codeOf('日')).toBeUndefined();
    expect(charactersWithoutCode(helvetica, 'A日\n日Ω')).toEqual(['日', 'Ω']);
    const courier = drawingOf(context, font({ BaseFont: 'Courier' }));
    expect(courier.codeOf('’')).toBe(0x27);
    expect(courier.codeOf("'")).toBe(0xa9);
    expect(courier.widthOf(0x27)).toBe(600);
    const symbol = drawingOf(context, font({ BaseFont: 'Symbol' }));
    expect(symbol.codeOf('α')).toBe(0x61);
    expect(symbol.codeOf('a')).toBeUndefined();
  });

  it('applies /Differences, and reads /Widths with /FirstChar and /MissingWidth', () => {
    const descriptor = context.obj({ Type: 'FontDescriptor', FontName: 'Custom', Flags: 32, MissingWidth: 250 });
    const custom = drawingOf(context, font({
      BaseFont: 'Custom', FirstChar: 65, LastChar: 67, Widths: [500, 600, 700], FontDescriptor: descriptor,
      Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [66, 'Omega', 'afii10017', 200, 'Euro'] },
    }));
    expect(custom.codeOf('A')).toBe(65);
    expect(custom.codeOf('B')).toBeUndefined();
    expect(custom.codeOf('Ω')).toBe(66);
    expect(custom.codeOf('А')).toBe(67);
    expect(custom.codeOf('€')).toBe(0x80);
    expect([65, 66, 67, 68, 200].map((code) => custom.widthOf(code))).toEqual([500, 600, 700, 250, 250]);
  });

  it('reads /ToUnicode over the encoding', () => {
    const cmap = context.register(context.stream(
      'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <41> <03A9> <42> <00660069> endbfchar '
      + '1 beginbfrange <61> <63> <0410> endbfrange 1 beginbfrange <70> <71> [<0058> <0059>] endbfrange endcmap', {}));
    const embedded = context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Sub', Flags: 4, FontFile3: context.register(context.stream('x', {})) });
    const subset = drawingOf(context, font({ BaseFont: 'ABCDEF+Sub', FirstChar: 0, LastChar: 255, Widths: new Array(256).fill(400), FontDescriptor: embedded, ToUnicode: cmap }));
    expect(subset.codeOf('Ω')).toBe(0x41);
    expect(subset.codeOf('fi')).toBe(0x42);
    expect(['А', 'Б', 'В'].map((c) => subset.codeOf(c))).toEqual([0x61, 0x62, 0x63]);
    expect([subset.codeOf('X'), subset.codeOf('Y')]).toEqual([0x70, 0x71]);
    expect(subset.codeOf('A')).toBeUndefined();
  });

  it('gives no drawing for a font it cannot read', () => {
    const program = context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Sym', Flags: 4, FontFile: context.register(context.stream('x', {})) });
    expect(unreadable(context, font({ BaseFont: 'ABCDEF+Sym', FirstChar: 0, Widths: [500], FontDescriptor: program }))).toBe('unmapped');
    expect(unreadable(context, font({ BaseFont: 'Arial', Encoding: 'WinAnsiEncoding' }))).toBe('widths');
    expect(unreadable(context, font({ Subtype: 'Type3' }))).toBe('type3');
    expect(unreadable(context, font({ Subtype: 'Type0', Encoding: 'Identity-V', DescendantFonts: [{}] }))).toBe('encoding');
    expect(unreadable(context, font({ Subtype: 'Type0', Encoding: 'UniJIS-UCS2-H', DescendantFonts: [{}] }))).toBe('encoding');
    expect(unreadable(context, undefined)).toBe('missing');
    expect(unreadable(context, PDFRef.of(9999))).toBe('missing');
  });
});

describe('what a composite font draws', () => {
  it('reads /ToUnicode, /W and /DW', () => {
    const context = PDFContext.create();
    const cmap = context.register(context.stream('1 beginbfrange <0003> <0005> <0041> endbfrange 1 beginbfchar <0010> <65E5> endbfchar', {}));
    const descendant = context.obj({ Type: 'Font', Subtype: 'CIDFontType2', DW: 900, W: [3, [610, 620], 16, 20, 1000] });
    const font = context.register(context.obj({ Type: 'Font', Subtype: 'Type0', Encoding: 'Identity-H', DescendantFonts: [descendant], ToUnicode: cmap }));
    const drawing = drawingOf(context, font);
    expect(drawing.codeBytes).toBe(2);
    expect(['A', 'B', 'C', '日', 'D'].map((c) => drawing.codeOf(c))).toEqual([3, 4, 5, 0x10, undefined]);
    expect([3, 4, 5, 16, 20, 21].map((code) => drawing.widthOf(code))).toEqual([610, 620, 900, 1000, 1000, 900]);
  });

  it('parses a range that ends in an array, and ignores a range that is not one', () => {
    const map = parseToUnicode(Uint8Array.from('beginbfrange <0001> <0002> [<0041> <0042>] <0005> <0001> <0043> endbfrange', (c) => c.charCodeAt(0)));
    expect([...map]).toEqual([[1, 'A'], [2, 'B']]);
  });

  it.skipIf(!HAS_FACES)('reads an embedded TrueType program when the font has no /ToUnicode, and no subset without a character map', async () => {
    const open = (bytes: Uint8Array): FontProgram => fontkit.create(bytes) as unknown as FontProgram;
    const build = async (subset: boolean): Promise<{ doc: PDFDocument; font: PDFFont }> => {
      const doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(face('LiberationSerif-Regular.ttf'), { subset });
      doc.addPage().drawText('Ab', { font });
      const loaded = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
      const fonts = loaded.getPage(0).node.Resources()!.lookup(N('Font'), PDFDict);
      const ref = fonts.get(fonts.keys()[0])!;
      loaded.context.lookup(ref, PDFDict).delete(N('ToUnicode'));
      return { doc: loaded, font: ref as unknown as PDFFont };
    };
    const whole = await build(false);
    const program = fontkit.create(face('LiberationSerif-Regular.ttf'));
    const drawing = drawingOf(whole.doc.context, whole.font as unknown as PDFObject, open);
    expect(drawing.codeOf('A')).toBe(program.glyphForCodePoint(0x41).id);
    expect(drawing.widthOf(drawing.codeOf('A')!)).toBeCloseTo((program.glyphForCodePoint(0x41).advanceWidth * 1000) / program.unitsPerEm, 0);
    expect(drawing.codeOf('日')).toBeUndefined();
    expect(unreadable(whole.doc.context, whole.font as unknown as PDFObject)).toBe('unmapped');
    const cut = await build(true);
    const reading = readFontDrawing(cut.doc.context, cut.font as unknown as PDFObject, open);
    expect('unreadable' in reading ? reading.unreadable : charactersWithoutCode(reading.drawing, 'Ab')).not.toEqual([]);
  }, RUN);
});

describe('the style a free text states', () => {
  it('reads a default style string', () => {
    expect(parseTextStyle('font: Helvetica,sans-serif 12.0pt; text-align:right; color:#FF0000; line-height:15pt'))
      .toMatchObject({ size: 12, align: 2, color: '1 0 0 rg', lineHeight: { points: 15 } });
    expect(parseTextStyle('font-size:9pt;text-align:center;color:#abc;line-height:1.5'))
      .toMatchObject({ size: 9, align: 1, color: '0.6667 0.7333 0.8 rg', lineHeight: { factor: 1.5 } });
    expect(parseTextStyle('color: rgb(0, 128, 255); line-height: 120%')).toMatchObject({ color: '0 0.502 1 rg', lineHeight: { factor: 1.2 } });
    expect(parseTextStyle('font-size:12px')).toEqual({ face: 'font-size:12px' });
    expect(parseTextStyle('')).toEqual({ face: '' });
  });

  it('reads a rich text string with one style, and tells one with two', () => {
    const one = parseRichText('<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" style="font-size:10pt;color:#0000FF">'
      + '<p style="text-align:center"><span style="font-size:11pt">One</span></p></body>');
    expect(one.mixed).toBe(false);
    expect(one.body).toMatchObject({ size: 11, color: '0 0 1 rg', align: 1 });
    const two = parseRichText('<body><p><span style="font-size:10pt">a</span><span style="font-size:14pt">b</span></p></body>');
    expect(two.mixed).toBe(true);
    expect(parseRichText('<body><p>plain <b>bold</b></p></body>').mixed).toBe(true);
    expect(parseRichText('<body><p>plain</p><p>plain</p></body>').mixed).toBe(false);
  });

  it('takes the rich text over the default style, and that over /DA and /Q', () => {
    const context = PDFContext.create();
    const times = context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', Encoding: 'WinAnsiEncoding' }));
    const stream = context.register(context.stream('BT /F1 10 Tf 13 TL (x) Tj ET', { Resources: { Font: { F1: times } } }));
    const base = { Type: 'Annot', Subtype: 'FreeText', Rect: [0, 0, 100, 40], AP: { N: stream }, Q: 2, BS: { W: 3 } };
    const read = (extra: Record<string, unknown>) => originalText(context, context.obj({ ...base, ...extra } as never) as unknown as PDFDict, () => undefined);
    const da = PDFString.of('0 0 1 rg /TiRo 10 Tf 14 TL');
    expect(read({ DA: da })).toMatchObject({ size: 10, leading: 14, align: 2, textColor: '0 0 1 rg', borderWidth: 3, mixed: false, faceless: false });
    expect(read({ DA: da }).font).toEqual({ name: 'F1', object: times });
    expect(read({ DA: da }).da).toBeUndefined();
    expect(read({ DA: PDFString.of('/F1 10 Tf') }).da).toBeDefined();
    expect(read({ DA: PDFString.of('/F1 10 Tf') })).toMatchObject({ leading: 13 });
    expect(read({ DA: da, DS: PDFString.of('font: Times 9pt; text-align:left; color:#FF0000; line-height:11pt') }))
      .toMatchObject({ size: 9, leading: 11, align: 0, textColor: '1 0 0 rg' });
    expect(read({ DA: da, DS: PDFString.of('font: Times 9pt'), RC: PDFString.of('<body style="font-size:8pt;text-align:center"><p>x</p></body>') }))
      .toMatchObject({ size: 8, align: 1 });
    expect(read({})).toMatchObject({ size: 10, leading: 13 });
    const bare = originalText(context, context.obj({ Type: 'Annot', Subtype: 'FreeText', DA: PDFString.of('/Ghost 12 Tf') }), () => undefined);
    expect(bare).toMatchObject({ size: 12, faceless: true });
    const fromDefaults = originalText(context, context.obj({ Type: 'Annot', Subtype: 'FreeText', DA: PDFString.of('/TiRo 12 Tf') }), (name) => (name === 'TiRo' ? times : undefined));
    expect(fromDefaults.font).toEqual({ name: 'TiRo', object: times });
    expect(fromDefaults.da).toBeDefined();
  });

  it('replaces the colour of a default appearance string and nothing else', () => {
    expect(defaultAppearanceWithColor('0 0 1 rg /TiRo 10 Tf', '1 0 0 rg')).toBe('1 0 0 rg /TiRo 10 Tf');
    expect(defaultAppearanceWithColor('/TiRo 10 Tf 0.5 g', '1 0 0 rg')).toBe('/TiRo 10 Tf 1 0 0 rg');
    expect(defaultAppearanceWithColor('/TiRo 10 Tf', '1 0 0 rg')).toBe('1 0 0 rg /TiRo 10 Tf');
  });
});

describe('lines and scripts', () => {
  const measure = (line: string): number => line.length * 10;

  it('breaks at spaces by the advances it is given, and inside a word wider than the line', () => {
    expect(wrapText('aaa bbb ccc', 70, measure)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapText('aaa bbb ccc', 75, measure)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapText('one\r\ntwo\rthree\n\nfour', 1000, measure)).toEqual(['one', 'two', 'three', '', 'four']);
    expect(wrapText('abcdefghij kl', 40, measure)).toEqual(['abcd', 'efgh', 'ij', 'kl']);
    expect(wrapText('', 40, measure)).toEqual(['']);
  });

  it('tells the text that needs a shaper or a line in display order', () => {
    expect(needsShaping('Plain text, éè Ж Ω 日本 가 •')).toBe(false);
    for (const text of ['שלום', 'سلام', 'नमस्ते', 'สวัส', 'ᠠ', 'a‮b', '가']) {
      expect(needsShaping(text), text).toBe(true);
    }
  });

  it('reads the family and the style of a font from its flags, its italic angle and its name', () => {
    const context = PDFContext.create();
    const font = (base: string, flags?: number, angle?: number): PDFObject => context.obj({
      Type: 'Font', Subtype: 'Type1', BaseFont: base,
      ...(flags !== undefined ? { FontDescriptor: { Type: 'FontDescriptor', Flags: flags, ...(angle !== undefined ? { ItalicAngle: angle } : {}) } } : {}),
    } as never);
    expect(faceStyleOf(context, font('Helvetica'))).toEqual({ family: 'sans' });
    expect(faceStyleOf(context, font('Times-BoldItalic'))).toEqual({ family: 'serif', bold: true, italic: true });
    expect(faceStyleOf(context, font('Courier-Oblique'))).toEqual({ family: 'mono', italic: true });
    expect(faceStyleOf(context, font('ABCDEF+Body', 2 | 32))).toEqual({ family: 'serif' });
    expect(faceStyleOf(context, font('ABCDEF+Body', 1 | 32))).toEqual({ family: 'mono' });
    expect(faceStyleOf(context, font('ABCDEF+Body', 32 | (1 << 18), -12))).toEqual({ family: 'sans', bold: true, italic: true });
    expect(faceStyleOf(context, undefined)).toEqual({ family: 'sans' });
  });
});

// ── The build ────────────────────────────────────────────────────────────

interface Fixture { bytes: Uint8Array; widthAt: (text: string, size: number) => number; show: (text: string) => string }

type Extra = Record<string, unknown>;

/** One page with one free text of another producer. `font` picks what the
 *  appearance shows the text in. */
async function foreign(options: {
  font: 'times' | 'embedded' | 'type3' | 'helvetica-bold';
  text?: string;
  extra?: Extra;
  callout?: boolean;
  size?: number;
}): Promise<Fixture> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const size = options.size ?? 10;
  const text = options.text ?? 'Ten point text';
  let font: PDFObject;
  let widthAt: Fixture['widthAt'];
  let show: Fixture['show'];
  if (options.font === 'embedded') {
    doc.registerFontkit(fontkit);
    const embedded = await doc.embedFont(face('LiberationSerif-Italic.ttf'), { subset: false, customName: 'ForeignItalic' });
    font = embedded.ref;
    widthAt = (line, at) => embedded.widthOfTextAtSize(line, at);
    show = (line) => embedded.encodeText(line).toString().toLowerCase();
    // The font holds every character the tests use, shown or not.
    embedded.encodeText('The quick brown fox jumps over the lazy dog 0123456789 Ten point text Changed');
  } else if (options.font === 'type3') {
    font = ctx.register(ctx.obj({
      Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { a: ctx.register(ctx.stream('1000 0 d0 0 0 800 800 re f', {})) }, Encoding: { Type: 'Encoding', Differences: [0, 'a'] },
      FirstChar: 0, LastChar: 0, Widths: [1000], Resources: {},
    }));
    widthAt = () => 0;
    show = () => '<00>';
  } else {
    const base = options.font === 'times' ? 'Times-Roman' : 'Helvetica-Bold';
    font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: base, Encoding: 'WinAnsiEncoding' }));
    const drawing = drawingOf(ctx, font);
    widthAt = (line, at) => [...line].reduce((total, c) => total + drawing.widthOf(drawing.codeOf(c)!), 0) * at / 1000;
    show = (line) => `<${[...line].map((c) => drawing.codeOf(c)!.toString(16).padStart(2, '0')).join('')}>`;
  }
  const rect = [50, 600, 250, 640];
  const stream = ctx.register(ctx.stream(
    `1 1 0.8 rg 0 0 200 40 re f BT /F7 ${size} Tf 0 0 1 rg 60 16 Td ${options.font === 'type3' ? '<00>' : show(text)} Tj ET`,
    { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 40], Resources: { Font: { F7: font } } },
  ));
  const annotation = ctx.obj({
    Type: 'Annot', Subtype: 'FreeText', Rect: rect, F: 4, C: [1, 1, 0.8], AP: { N: stream }, P: page.ref, BS: { W: 2 }, Q: 2,
    ...(options.callout ? { IT: 'FreeTextCallout', CL: [20, 560, 40, 590, 50, 610], LE: 'OpenArrow', Rect: [18, 558, 250, 640], RD: [32, 0, 0, 42] } : {}),
    ...(options.extra ?? {}),
  } as never) as unknown as PDFDict;
  annotation.set(N('DA'), PDFString.of(`0 0 1 rg /F7 ${size} Tf`));
  annotation.set(N('Contents'), PDFHexString.fromText(text));
  annotation.set(N('NM'), PDFString.of('text-1'));
  annotation.set(N('T'), PDFString.of('A. Reviewer'));
  page.node.set(N('Annots'), ctx.obj([ctx.register(annotation)]));
  doc.catalog.set(N('AcroForm'), ctx.register(ctx.obj({ Fields: [], DR: { Font: { F7: font } } })));
  return { bytes: await doc.save({ useObjectStreams: false }), widthAt, show };
}

interface Written {
  dict: PDFDict;
  doc: PDFDocument;
  content: string;
  fonts: Record<string, PDFDict>;
  fontRefs: Record<string, PDFObject | undefined>;
  da: string;
  /** Each shown line: its x, its y and its string operand. */
  lines: { x: number; y: number; shown: string }[];
}

async function written(bytes: Uint8Array): Promise<Written> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = doc.getPage(0).node.lookup(N('Annots'), PDFArray);
  const dict = annots.lookup(0, PDFDict);
  const normal = dict.lookup(N('AP'), PDFDict).lookup(N('N')) as PDFStream;
  const content = latin1(normal instanceof PDFRawStream ? decodePDFRawStream(normal).decode() : normal.getContents());
  const held = normal.dict.lookup(N('Resources'), PDFDict).lookup(N('Font'), PDFDict);
  const fonts: Written['fonts'] = {};
  const fontRefs: Written['fontRefs'] = {};
  for (const [key, value] of held.entries()) {
    fonts[key.decodeText()] = doc.context.lookup(value, PDFDict);
    fontRefs[key.decodeText()] = value;
  }
  const da = dict.lookup(N('DA'));
  const corner = /1 0 0 1 ([-\d.]+) ([-\d.]+) cm BT/.exec(content);
  const [left, top] = corner ? [Number(corner[1]), Number(corner[2])] : [0, 0];
  const lines = [...content.matchAll(/1 0 0 1 ([-\d.]+) ([-\d.]+) Tm (<[0-9a-fA-F]*>) Tj/g)]
    .map((m) => ({ x: left + Number(m[1]), y: top + Number(m[2]), shown: m[3] }));
  return { dict, doc, content, fonts, fontRefs, da: da instanceof PDFString || da instanceof PDFHexString ? da.decodeText() : '', lines };
}

/** The text pdf.js reads from the appearance of the first annotation. */
async function appearanceText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await loadPdf(bytes);
  const annots = await (await pdf.getPage(1)).getAnnotations({ intent: 'display' }) as { textContent?: string[] }[];
  await pdf.loadingTask.destroy();
  return annots[0].textContent ?? [];
}

const editing = (edit: (a: PageAnnotation) => PageAnnotation) => (pages: PageRef[]): PageRef[] =>
  pages.map((page) => ({ ...page, annotations: (page.annotations ?? []).map((a) => (a.kind === 'freetext' || a.kind === 'callout' ? edit(a) : a)) }));
const taller = (a: PageAnnotation): PageAnnotation => ({ ...a, h: a.h * 1.5, geometryDiverged: true });
const saying = (note: string) => (a: PageAnnotation): PageAnnotation => ({ ...a, note });
const baseFont = (font: PDFDict): string => String(font.lookup(N('BaseFont')));
const defaults = (doc: PDFDocument): Record<string, string> => {
  const fonts = doc.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('DR'), PDFDict).lookup(N('Font'), PDFDict);
  return Object.fromEntries(fonts.entries().map(([key, value]) => [key.decodeText(), baseFont(doc.context.lookup(value, PDFDict))]));
};

describe('a soft hyphen in an imported font subset', () => {
  const planFor = (pairs: [string, string][], shown: string) => {
    const context = PDFContext.create();
    const cmap = context.register(context.stream(
      `1 begincodespacerange <00> <FF> endcodespacerange ${pairs.length} beginbfchar `
        + `${pairs.map(([code, unicode]) => `<${code}> <${unicode}>`).join(' ')} endbfchar`,
      {},
    ));
    const program = context.register(context.stream('font program', {}));
    const descriptor = context.register(context.obj({
      Type: 'FontDescriptor', FontName: 'ForeignSubset', Flags: 32, FontFile2: program,
    } as never));
    const descendant = context.register(context.obj({
      Type: 'Font', Subtype: 'CIDFontType2', DW: 500, FontDescriptor: descriptor,
    } as never));
    const font = context.register(context.obj({
      Type: 'Font', Subtype: 'Type0', BaseFont: 'ForeignSubset', Encoding: 'Identity-H',
      DescendantFonts: [descendant], ToUnicode: cmap,
    } as never));
    const appearance = context.register(context.stream(
      `BT /F7 10 Tf <${shown}> Tj ET`,
      { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20], Resources: { Font: { F7: font } } },
    ));
    const original = context.obj({
      Type: 'Annot', Subtype: 'FreeText', Rect: [0, 0, 100, 20],
      AP: { N: appearance }, DA: PDFString.of('0 0 1 rg /F7 10 Tf'),
      Contents: PDFHexString.fromText('ab\u00adcd'),
    } as never) as unknown as PDFDict;

    return planFreeTextRedraw(context, {
      original, text: 'ab\u00adcd', textChanged: false, sourceFont: () => undefined,
    }, undefined);
  };

  it('refuses to redraw with an embedded subset that lacks the drawn hyphen-minus code', () => {
    expect(planFor([
      ['01', '0061'], ['02', '0062'], ['03', '00AD'], ['04', '0063'], ['05', '0064'],
    ], '0102030405')).toEqual({ refusal: 'font' });
  });

  it('keeps a subset that has the drawn glyphs even when the break marker has no code', () => {
    expect(planFor([
      ['01', '0061'], ['02', '0062'], ['04', '0063'], ['05', '0064'], ['06', '002D'],
    ], '01020405')).toMatchObject({ via: 'font', size: 10 });
  });
});

describe('an imported free text drawn again with its text unchanged', () => {
  it('shows the text in the original standard font, at its size and colour, set right by the font\'s own advances', async () => {
    const fixture = await foreign({ font: 'times' });
    const output = await commit(fixture.bytes, editing(taller));
    await expectSound(output);
    const out = await written(output);
    expect(Object.keys(out.fonts)).toEqual(['F7']);
    expect(baseFont(out.fonts.F7)).toBe('/Times-Roman');
    expect(out.content).toMatch(/q 0 0 1 rg 12 TL 1 0 0 1 [\d.]+ [\d.]+ cm BT \/F7 10 Tf /);
    expect(out.content).not.toContain('Helv');
    expect(out.da).toBe('0 0 1 rg /F7 10 Tf');
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].shown).toBe(fixture.show('Ten point text'));
    // Right aligned in a box of 200 with 3 of padding.
    expect(out.lines[0].x).toBeCloseTo(197 - fixture.widthAt('Ten point text', 10), 2);
    expect(out.lines[0].y).toBeCloseTo(60 - 3 - 10, 2);
    expect(defaults(out.doc)).toEqual({ F7: '/Times-Roman' });
    expect(out.dict.lookup(N('Q'))).toEqual(out.doc.context.obj(2));
  }, RUN);

  it.skipIf(!HAS_FACES)('shows the text in the original embedded font: the same font object, its codes and its advances', async () => {
    const fixture = await foreign({ font: 'embedded', size: 14, text: 'The quick brown fox jumps over the lazy dog' });
    const programs = (doc: PDFDocument): number => doc.context.enumerateIndirectObjects()
      .filter(([, object]) => object instanceof PDFDict && object.get(N('FontFile2')) !== undefined).length;
    const output = await commit(fixture.bytes, editing(taller));
    await expectSound(output);
    const out = await written(output);
    expect(baseFont(out.fonts.F7)).toBe('/ForeignItalic');
    expect(String(out.fonts.F7.lookup(N('Subtype')))).toBe('/Type0');
    // The edit adds no font program: the output holds as many as a commit
    // with no edit, and the appearance names the program the original named.
    const untouched = await written(await commit(fixture.bytes));
    expect(programs(out.doc)).toBe(programs(untouched.doc));
    const program = (w: Written): string => {
      const descendant = w.fonts.F7.lookup(N('DescendantFonts'), PDFArray).lookup(0, PDFDict);
      const file = descendant.lookup(N('FontDescriptor'), PDFDict).lookup(N('FontFile2')) as PDFRawStream;
      return latin1(file.contents);
    };
    expect(program(out)).toBe(program(untouched));
    expect(out.content).toMatch(/q 0 0 1 rg 16\.8 TL 1 0 0 1 [\d.]+ [\d.]+ cm BT \/F7 14 Tf /);
    // Two lines by the font's own advances in a box of 194.
    expect(out.lines.map((line) => line.shown)).toEqual([fixture.show('The quick brown fox jumps over'), fixture.show('the lazy dog')]);
    expect(fixture.widthAt('The quick brown fox jumps over the', 14)).toBeGreaterThan(194);
    expect(out.lines[1].x).toBeCloseTo(197 - fixture.widthAt('the lazy dog', 14), 1);
    expect(out.lines[0].y - out.lines[1].y).toBeCloseTo(16.8, 3);
    expect(out.da).toBe('0 0 1 rg /F7 14 Tf');
  }, RUN);

  it('takes the size, the colour, the alignment and the leading from the default style', async () => {
    const fixture = await foreign({ font: 'times', extra: { DS: PDFString.of('font: Times 9pt; text-align:left; color:#FF0000; line-height:15pt') } });
    const out = await written(await commit(fixture.bytes, editing(taller)));
    expect(out.content).toMatch(/q 1 0 0 rg 15 TL 1 0 0 1 [\d.]+ [\d.]+ cm BT \/F7 9 Tf /);
    expect(out.lines[0].x).toBe(3);
    expect(out.dict.lookup(N('DS'))).toBeDefined();
  }, RUN);

  it('draws a callout in the original font, never at the builder\'s size', async () => {
    const fixture = await foreign({ font: 'times', callout: true });
    const output = await commit(fixture.bytes, editing((a) => ({ ...a, strokeWidth: 3 })));
    await expectSound(output);
    const out = await written(output);
    expect(String(out.dict.lookup(N('IT')))).toBe('/FreeTextCallout');
    expect(Object.keys(out.fonts)).toEqual(['F7']);
    expect(baseFont(out.fonts.F7)).toBe('/Times-Roman');
    expect(out.content).toMatch(/q 0 0 1 rg 12 TL 1 0 0 1 [\d.]+ [\d.]+ cm BT \/F7 10 Tf /);
    expect(out.content).not.toContain('/Helv');
    expect(out.lines.map((line) => line.shown)).toEqual([fixture.show('Ten point text')]);
    expect(out.da).toBe('0 0 1 rg /F7 10 Tf');
  }, RUN);

  it('keeps the text colour of /DA when the user changes the colour of nothing', async () => {
    const fixture = await foreign({ font: 'times' });
    const recoloured = await written(await commit(fixture.bytes, editing((a) => ({ ...taller(a), color: '#00ff00' }))));
    expect(recoloured.content).toMatch(/q 0 1 0 rg 12 TL 1 0 0 1 [\d.]+ [\d.]+ cm BT \/F7 10 Tf /);
    expect(recoloured.da).toBe('0 1 0 rg /F7 10 Tf');
  }, RUN);
});

describe('an imported free text drawn again with a new text', () => {
  it('stays in the original font when the font holds every character', async () => {
    const fixture = await foreign({ font: 'times' });
    const output = await commit(fixture.bytes, editing(saying('Changed €•')));
    await expectSound(output, ['Ten point text']);
    const out = await written(output);
    expect(baseFont(out.fonts.F7)).toBe('/Times-Roman');
    expect(out.lines.map((line) => line.shown)).toEqual(['<4368616e676564208095>']);
    expect(out.da).toBe('0 0 1 rg /F7 10 Tf');
  }, RUN);

  it.skipIf(!HAS_FACES)('goes to the bundled face of the font\'s family and style when the font lacks a character', async () => {
    const fixture = await foreign({ font: 'times', extra: { DS: PDFString.of('font: Times 10pt'), RC: PDFString.of('<body><p>Ten point text</p></body>') } });
    const output = await commit(fixture.bytes, editing(saying('Ohm Ω')));
    await expectSound(output, ['Ten point text']);
    const out = await written(output);
    expect(Object.keys(out.fonts)).toEqual(['LiberationSerif']);
    const font = out.fonts.LiberationSerif;
    expect(baseFont(font)).toMatch(/^\/[A-Z]{6}\+LiberationSerif$/);
    expect(String(font.lookup(N('Subtype')))).toBe('/Type0');
    expect(font.lookup(N('ToUnicode'))).toBeDefined();
    expect(out.content).toMatch(/q 0 0 1 rg 12 TL 1 0 0 1 [\d.]+ [\d.]+ cm BT 1 0 0 1 [\d.]+ -10 Tm \/LiberationSerif 10 Tf /);
    expect(out.da).toBe('0 0 1 rg /LiberationSerif 10 Tf');
    expect(defaults(out.doc).LiberationSerif).toBe(baseFont(font));
    expect(out.dict.lookup(N('DS'))).toBeUndefined();
    expect(out.dict.lookup(N('RC'))).toBeUndefined();
    expect(String(out.dict.lookup(N('T')))).toBe('(A. Reviewer)');
    // The same input gives the same subset name.
    const again = await written(await commit(fixture.bytes, editing(saying('Ohm Ω'))));
    expect(baseFont(again.fonts.LiberationSerif)).toBe(baseFont(font));
    const other = await written(await commit(fixture.bytes, editing(saying('Ohm ΩΣ'))));
    expect(baseFont(other.fonts.LiberationSerif)).not.toBe(baseFont(font));
  }, RUN);

  it.skipIf(!HAS_FACES)('matches a bold font with the bold face, and takes the CJK face for a text the family face lacks', async () => {
    const fixture = await foreign({ font: 'helvetica-bold' });
    const bold = await written(await commit(fixture.bytes, editing(saying('Ohm Ω'))));
    expect(Object.keys(bold.fonts)).toEqual(['LiberationSans-Bold']);
    const output = await commit(fixture.bytes, editing(saying('日本語')));
    await expectSound(output, ['Ten point text']);
    const cjk = await written(output);
    expect(Object.keys(cjk.fonts)).toEqual(['NotoSansCJKsc-Bold']);
    expect(cjk.content.match(/ Tm /g)).toHaveLength(1);
    expect(cjk.da).toBe('0 0 1 rg /NotoSansCJKsc-Bold 10 Tf');
  }, RUN);

  it.skipIf(!HAS_FACES)('goes to a bundled face when the original font cannot be read', async () => {
    const fixture = await foreign({ font: 'type3' });
    const out = await written(await commit(fixture.bytes, editing(saying('Changed'))));
    expect(Object.keys(out.fonts)).toEqual(['LiberationSans']);
  }, RUN);
});

describe('an edit of a free text that cannot be drawn as its original showed it', () => {
  const recoloured = (a: PageAnnotation): PageAnnotation => ({ ...a, color: '#00ff00' });
  const rectOf = (out: Written): number[] => out.dict.lookup(N('Rect'), PDFArray).asArray().map((entry) => Number(String(entry)));

  it('keeps the appearance scaled into the new rectangle when the font cannot be read, and refuses another colour', async () => {
    const fixture = await foreign({ font: 'type3' });
    const before = await written(await commit(fixture.bytes));
    const resized = await commit(fixture.bytes, editing(taller));
    await expectSound(resized);
    const out = await written(resized);
    // The original with its appearance: the same content, the same box, a
    // taller /Rect the viewer maps the box onto (12.5.5).
    expect(out.content).toBe(before.content);
    expect(String(out.fonts.F7.lookup(N('Subtype')))).toBe('/Type3');
    expect(rectOf(out)[3] - rectOf(out)[1]).toBeCloseTo((rectOf(before)[3] - rectOf(before)[1]) * 1.5, 3);
    expect(rectOf(out)[2] - rectOf(out)[0]).toBeCloseTo(rectOf(before)[2] - rectOf(before)[0], 3);
    expect(String(out.dict.lookup(N('T')))).toBe('(A. Reviewer)');
    await expect(commit(fixture.bytes, editing(recoloured)))
      .rejects.toThrow(/Page 1, Text box \u201cTen point text\u201d: the font of this text cannot be read/);
    const moved = await commit(fixture.bytes, editing((a) => ({ ...a, x: a.x + 0.1, geometryDiverged: true })));
    await expectSound(moved);
    expect((await written(moved)).content).toBe(before.content);
  }, RUN);

  it.skipIf(!HAS_FACES)('draws an unchanged text a font with no program has no code for, in the bundled face of its family', async () => {
    const plain = await foreign({ font: 'times' });
    const doc = await PDFDocument.load(plain.bytes, { updateMetadata: false });
    doc.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(0, PDFDict).set(N('Contents'), PDFHexString.fromText('Ohm Ω'));
    const bytes = await doc.save({ useObjectStreams: false });
    const output = await commit(bytes, editing(taller));
    await expectSound(output);
    const out = await written(output);
    expect(Object.keys(out.fonts)).toEqual(['LiberationSerif']);
    expect(out.da).toBe('0 0 1 rg /LiberationSerif 10 Tf');
    expect(await appearanceText(output)).toEqual(['Ohm Ω']);
  }, RUN);

  it('keeps the appearance of a text in two styles scaled, refuses another colour, and lets its text be replaced', async () => {
    const rich = PDFString.of('<body><p><span style="font-size:10pt">Ten point</span> <span style="font-size:14pt">text</span></p></body>');
    const fixture = await foreign({ font: 'times', extra: { RC: rich } });
    const before = await written(await commit(fixture.bytes));
    const resized = await written(await commit(fixture.bytes, editing(taller)));
    expect(resized.content).toBe(before.content);
    expect(resized.dict.lookup(N('RC'))).toBeDefined();
    await expect(commit(fixture.bytes, editing(recoloured))).rejects.toThrow(/this text has more than one style/);
    const out = await written(await commit(fixture.bytes, editing(saying('Replaced'))));
    expect(out.lines.map((line) => line.shown)).toEqual([fixture.show('Replaced')]);
    expect(out.dict.lookup(N('RC'))).toBeUndefined();
  }, RUN);

  it.skipIf(!HAS_FACES)('draws a new text that needs shaping or a right-to-left line in the bundled faces', async () => {
    const fixture = await foreign({ font: 'times' });
    const hebrew = await commit(fixture.bytes, editing(saying('שלום עולם')));
    await expectSound(hebrew, ['Ten point text']);
    expect(await appearanceText(hebrew)).toEqual(['שלום עולם']);
    expect(Object.keys((await written(hebrew)).fonts)).toEqual(['LiberationSerif']);
    const arabic = await commit(fixture.bytes, editing(saying('مرحبا')));
    await expectSound(arabic, ['Ten point text']);
    expect(await appearanceText(arabic)).toEqual(['مرحبا']);
    expect(Object.keys((await written(arabic)).fonts)).toEqual(['IBMPlexSansArabic']);
  }, RUN);

  it('refuses a new text with a character no bundled face holds, and names the character', async () => {
    const fixture = await foreign({ font: 'type3' });
    await expect(commit(fixture.bytes, editing(saying('Smile \u{1F600}'))))
      .rejects.toThrow(/Page 1, Text box \u201cSmile \u{1F600}\u201d: no font of this editor draws these characters: \u{1F600}\./u);
  }, RUN);
});

describe('a text box this editor wrote, read back and drawn again', () => {
  it('stays in the standard face with the advances of that face', async () => {
    const blank = await PDFDocument.create();
    blank.addPage([300, 600]);
    const box: PageAnnotation = { id: 'box', kind: 'freetext', x: 0.2, y: 0.2, w: 0.5, h: 0.1, color: '#2563eb', note: 'A text box of this editor' };
    const once = await commit(await blank.save(), ([page]) => [{ ...page, annotations: [box] }]);
    const twice = await commit(once, editing(taller));
    await expectSound(twice);
    const out = await written(twice);
    expect(Object.keys(out.fonts)).toEqual(['Helv']);
    expect(baseFont(out.fonts.Helv)).toBe('/Helvetica');
    expect(out.content).toMatch(/ rg 14\.4 TL 1 0 0 1 3 [\d.]+ cm BT \/Helv 12 Tf /);
    expect(out.lines.map((line) => line.shown)).toEqual([`<${Buffer.from('A text box of this editor', 'latin1').toString('hex')}>`]);
    expect(out.da).toMatch(/ rg \/Helv 12 Tf$/);
    expect(defaults(out.doc)).toEqual({ Helv: '/Helvetica' });
  }, RUN);
});
