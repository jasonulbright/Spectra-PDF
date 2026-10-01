import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy } from 'pdfjs-dist';
import { itemOrientation, orderedPageText, partition, type OrientedItem } from '../src/renderer/search/text-order';

// The renderer half of the shared reading-order table. The SAME JSON drives
// tests/test_reading_order.py: the engine's export, search and read-aloud and
// the renderer's search and copy must read one page in one order.

type DrawItem = { text: string; tm: number[] } | { cids: number[]; at: [number, number] };

interface PageCase {
  name: string;
  rotate: number;
  draw: DrawItem[];
  lines: string[];
  readers: string[];
}

interface Corpus {
  vertical_font: Record<string, string>;
  rotations: Array<[number, number]>;
  orientations: Array<{ matrix: number[]; vertical: boolean; rotate: number; angle: number; reflected: boolean }>;
  partitions: Array<{ items: Array<[string, number, boolean?]>; parts: Array<[number, boolean, string[]]> }>;
  pages: PageCase[];
}

const corpus = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'reading-order-corpus.json'), 'utf-8')) as Corpus;

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

const hex4 = (n: number): string => n.toString(16).padStart(4, '0');

function draw(items: readonly DrawItem[]): string {
  return items
    .map((item) =>
      'cids' in item
        ? `BT /FV 20 Tf ${item.at[0]} ${item.at[1]} Td <${item.cids.map(hex4).join('')}> Tj ET\n`
        : `BT /F1 12 Tf ${item.tm.join(' ')} Tm (${item.text}) Tj ET\n`,
    )
    .join('');
}

/** The page tests/test_reading_order.py builds: /F1 Helvetica, /FV the
 * corpus's Identity-V font advancing one em down per code. */
async function pagePdf(content: string, rotate: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([612, 792]);
  const codes = Object.keys(corpus.vertical_font).map(Number).sort((a, b) => a - b);
  const bfchar = codes.map((code) => `<${hex4(code)}> <${hex4(corpus.vertical_font[String(code)].codePointAt(0) ?? 0)}>`);
  const cmap =
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <ffff>\n' +
    `endcodespacerange\n${bfchar.length} beginbfchar\n${bfchar.join('\n')}\nendbfchar\n` +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  const descendant = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'Probe',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      DW: 1000,
      W: codes.flatMap((code) => [code, [1000]]),
      W2: codes.flatMap((code) => [code, [-1000, 500, 880]]),
      DW2: [880, -1000],
    }),
  );
  const vertical = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'Probe',
      Encoding: 'Identity-V',
      DescendantFonts: [descendant],
      ToUnicode: ctx.register(ctx.stream(cmap)),
    }),
  );
  const helvetica = ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }),
  );
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helvetica, FV: vertical } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
  page.node.set(PDFName.of('Rotate'), PDFNumber.of(rotate));
  return doc.save();
}

async function withPage<T>(bytes: Uint8Array, read: (page: PDFPageProxy) => Promise<T>): Promise<T> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    return await read(await (await task.promise).getPage(1));
  } finally {
    await task.destroy();
  }
}

async function rendererLines(page: PDFPageProxy): Promise<string[]> {
  const content = await page.getTextContent();
  const items = content.items.flatMap((item): OrientedItem[] => ('str' in item ? [item] : []));
  return orderedPageText(items, page.rotate)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('reading-order corpus, renderer side', () => {
  it.each(corpus.rotations)('/Rotate %s displays as %s', async (value, degrees) => {
    expect(await withPage(await pagePdf('', value), async (page) => page.rotate)).toBe(degrees);
  });

  it.each(corpus.orientations)('orientation of $matrix (vertical $vertical, rotate $rotate)', (row) => {
    const item: OrientedItem = { str: 'x', transform: [...row.matrix, 0, 0], dir: row.vertical ? 'ttb' : 'ltr' };
    const got = itemOrientation(item, row.rotate);
    expect(got.angle).toBeCloseTo(row.angle, 9);
    expect(got.reflected).toBe(row.reflected);
  });

  it.each(corpus.partitions)('partition of $items', (row) => {
    const parts = partition(
      row.items,
      (item) => ({ angle: item[1], reflected: item[2] ?? false }),
      (item) => Array.from(item[0]).length,
    );
    expect(parts.map((part) => [part.key.reflected, part.members.map((item) => item[0])])).toEqual(
      row.parts.map(([, reflected, texts]) => [reflected, texts]),
    );
    parts.forEach((part, n) => expect(part.key.angle).toBeCloseTo(row.parts[n][0], 6));
  });

  const pages = corpus.pages.filter((page) => page.readers.includes('renderer')).map((page) => [page.name, page] as const);
  it.each(pages)('%s', async (_name, page) => {
    expect(await withPage(await pagePdf(draw(page.draw), page.rotate), rendererLines)).toEqual(page.lines);
  });
});
