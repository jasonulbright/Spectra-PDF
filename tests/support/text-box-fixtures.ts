// Fixtures of the text box tests: the annotations they place, the files of
// another producer they import, and the reading of a saved appearance.
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString, decodePDFRawStream,
} from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { initialState } from '../../src/renderer/state/reducer';
import type { AppState, OpenDocument, OpenFile, PageAnnotation, PageRef } from '../../src/renderer/state/types';
import { parseToUnicode, readFontDrawing } from '../../src/renderer/lib/annotation-font';
import { latin1, loadPdf } from './saved-pdf';

const N = PDFName.of;

export const POLISH = 'Zażółć gęślą jaźń';
export const CJK = '中文 日本語 한국어';
export const HEBREW = 'שלום עולם';
export const ARABIC = 'مرحبا بالعالم';

export async function blank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);
  return doc.save({ useObjectStreams: false });
}

export const box = (note: string, over: Partial<PageAnnotation> = {}): PageAnnotation =>
  ({ id: `box-${note}`, kind: 'freetext', x: 0.1, y: 0.1, w: 0.6, h: 0.1, color: '#2563eb', note, ...over });

export const placing = (...annotations: PageAnnotation[]) => ([page]: PageRef[]): PageRef[] => [{ ...page, annotations }];
export const editingAll = (edit: (a: PageAnnotation) => PageAnnotation) => (pages: PageRef[]): PageRef[] =>
  pages.map((page) => ({ ...page, annotations: (page.annotations ?? []).map(edit) }));
export const taller = (a: PageAnnotation): PageAnnotation => ({ ...a, h: a.h * 1.5, geometryDiverged: true });

export interface Appearance {
  dict: PDFDict;
  content: string;
  fonts: Record<string, PDFDict>;
  /** The text the content shows, in the order it shows it. */
  shown: string;
  /** The same, by line. */
  lines: string[];
  da: string;
}

export function bytesOf(stream: PDFObject | undefined): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (stream instanceof PDFStream) return stream.getContents();
  return new Uint8Array();
}

/** Decodes every string a content stream shows by the font it selects: a
 *  simple font by its encoding, a composite font by its /ToUnicode. */
export function shownLines(doc: PDFDocument, content: string, fonts: Record<string, PDFDict>): string[] {
  const out: string[] = [];
  let decode: (hex: string) => string = () => '';
  for (const token of content.matchAll(/\/([^\s/<>[\]()]+)\s+[-\d.]+\s+Tf|<([0-9a-fA-F]*)>|\s(Tm|Td)\s/g)) {
    if (token[3] !== undefined) out.push('');
    else if (token[1] !== undefined) {
      const font = fonts[token[1]];
      if (!font) throw new Error(`the content selects ${token[1]}, which its resources do not hold`);
      if (String(font.lookup(N('Subtype'))) === '/Type0') {
        const map = parseToUnicode(bytesOf(font.lookup(N('ToUnicode'))));
        decode = (hex) => (hex.match(/.{4}/g) ?? []).map((code) => {
          const text = map.get(parseInt(code, 16));
          if (text === undefined) throw new Error(`code ${code} has no text`);
          return text;
        }).join('');
      } else {
        const reading = readFontDrawing(doc.context, font);
        if (!('drawing' in reading)) throw new Error('unreadable simple font');
        const byCode = new Map(reading.drawing.held().map((point) => [reading.drawing.codeOf(String.fromCodePoint(point))!, String.fromCodePoint(point)]));
        decode = (hex) => (hex.match(/.{2}/g) ?? []).map((code) => byCode.get(parseInt(code, 16)) ?? '�').join('');
      }
    } else {
      if (out.length === 0) out.push('');
      out[out.length - 1] += decode(token[2]);
    }
  }
  return out;
}

export async function appearances(bytes: Uint8Array): Promise<Appearance[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = doc.getPage(0).node.lookupMaybe(N('Annots'), PDFArray);
  const out: Appearance[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const dict = annots!.lookup(i, PDFDict);
    const normal = dict.lookup(N('AP'), PDFDict).lookup(N('N')) as PDFStream;
    const content = latin1(bytesOf(normal));
    const held = normal.dict.lookup(N('Resources'), PDFDict).lookupMaybe(N('Font'), PDFDict);
    const fonts: Record<string, PDFDict> = {};
    for (const [key, value] of held?.entries() ?? []) fonts[key.decodeText()] = doc.context.lookup(value, PDFDict);
    const da = dict.lookup(N('DA'));
    const lines = shownLines(doc, content, fonts);
    out.push({
      dict, content, fonts, shown: lines.join(''), lines,
      da: da instanceof PDFString || da instanceof PDFHexString ? da.decodeText() : '',
    });
  }
  return out;
}

/** The text pdf.js reads from the appearance of each annotation. */
export async function readByViewer(bytes: Uint8Array): Promise<string[][]> {
  const pdf = await loadPdf(bytes);
  const annots = await (await pdf.getPage(1)).getAnnotations({ intent: 'display' }) as { textContent?: string[] }[];
  await pdf.loadingTask.destroy();
  return annots.map((a) => a.textContent ?? []);
}

export const baseFont = (font: PDFDict): string => String(font.lookup(N('BaseFont')));
export const programs = (font: PDFDict): boolean => {
  const descendants = font.lookup(N('DescendantFonts'));
  const descriptor = descendants instanceof PDFArray
    ? descendants.lookup(0, PDFDict).lookup(N('FontDescriptor')) : font.lookup(N('FontDescriptor'));
  return descriptor instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => descriptor.has(N(key)));
};
export const sorted = (text: string): string => [...text.replace(/\s/g, '')].sort().join('');
export const defaults = (doc: PDFDocument): Record<string, string> => {
  const form = doc.catalog.lookup(N('AcroForm'));
  const fonts = form instanceof PDFDict ? form.lookup(N('DR'), PDFDict).lookup(N('Font'), PDFDict) : undefined;
  return Object.fromEntries((fonts?.entries() ?? []).map(([key, value]) => [key.decodeText(), baseFont(doc.context.lookup(value, PDFDict))]));
};

export function opened(pages: PageRef[], bytes: Uint8Array): AppState {
  const file: OpenFile = { path: 'a.pdf', workingPath: 'a.pdf.w', name: 'a.pdf', pageCount: pages.length, buffer: bytes, dirty: false, undoStack: [], redoStack: [] };
  const doc: OpenDocument = { ...file, id: 'a.pdf#0', pages, pageCount: pages.length };
  return { ...initialState, activeFileId: 'a.pdf', files: new Map([['a.pdf', file]]), workspace: { documents: [doc] } };
}

export const pagesOf = (state: AppState): PageRef[] => state.workspace.documents[0].pages;
export const only = (state: AppState): PageAnnotation => pagesOf(state)[0].annotations![0];

/** One free text of another producer in a font the editor cannot read
 *  (`type3`), in a standard font, or in two styles. `q` is its /Q. */
export async function foreign(
  kind: 'type3' | 'times' | 'styled' | 'helvetica', contents = 'Ten point text', q?: 0 | 1 | 2,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const font = kind === 'type3'
    ? ctx.register(ctx.obj({
      Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { a: ctx.register(ctx.stream('1000 0 d0 0 0 800 800 re f', {})) }, Encoding: { Type: 'Encoding', Differences: [0, 'a'] },
      FirstChar: 0, LastChar: 0, Widths: [1000], Resources: {},
    }))
    : ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: kind === 'helvetica' ? 'Helvetica' : 'Times-Roman', Encoding: 'WinAnsiEncoding' }));
  const shown = kind === 'type3' ? '<00>' : `(${contents})`;
  const stream = ctx.register(ctx.stream(
    `1 1 0.8 rg 0 0 200 40 re f BT /F7 10 Tf 0 0 1 rg 6 16 Td ${shown} Tj ET`,
    { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 40], Resources: { Font: { F7: font } } },
  ));
  const annotation = ctx.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [50, 600, 250, 640], F: 4, C: [1, 1, 0.8], AP: { N: stream }, P: page.ref }) as PDFDict;
  annotation.set(N('DA'), PDFString.of('0 0 1 rg /F7 10 Tf'));
  annotation.set(N('Contents'), PDFHexString.fromText(contents));
  if (q !== undefined) annotation.set(N('Q'), ctx.obj(q));
  if (kind === 'styled') {
    annotation.set(N('RC'), PDFString.of('<body><p><span style="font-size:10pt">Ten point</span> <span style="font-size:14pt">text</span></p></body>'));
  }
  page.node.set(N('Annots'), ctx.obj([ctx.register(annotation)]));
  doc.catalog.set(N('AcroForm'), ctx.register(ctx.obj({ Fields: [], DR: { Font: { F7: font } } })));
  return doc.save({ useObjectStreams: false });
}
