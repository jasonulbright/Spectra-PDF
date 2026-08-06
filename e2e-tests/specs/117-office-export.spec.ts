// The three export targets the engine produces from the document itself:
// a spreadsheet, a presentation and a plain-text transcription.
//
// The load-bearing assertions are the ones a byte count cannot make. For the
// spreadsheet it is the CELLS, at their addresses, read back out of the written
// package — a workbook that opens and looks fine is exactly what a missed
// column produces. For the presentation it is the SLIDE COUNT: a conversion can
// write a well-formed, non-empty package with no slides in it at all.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { writeFileSync } from 'node:fs';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  exportActiveAs,
} from '../support/harness.js';

const ROWS = [
  ['Region', 'Q1', 'Q2', 'Q3'],
  ['North', '1200', '1310', '1455'],
  ['South', '980', '1024', '1190'],
  ['East', '1500', '1490', '1610'],
  ['West', '745', '820', '905'],
];
const COL_X = [72, 250, 350, 450, 540];
const ROW_Y = [700, 676, 652, 628, 604, 580];

let work: string;

/** A ruled 5x4 grid plus a heading, on `pages` pages. */
async function buildTablePdf(path: string, pages: number): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 0; n < pages; n += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Quarterly revenue by region ${n + 1}`, {
      x: 72, y: 750, size: 14, font,
    });
    for (const y of ROW_Y) {
      page.drawLine({ start: { x: COL_X[0], y }, end: { x: COL_X[4], y }, thickness: 0.8 });
    }
    for (const x of COL_X) {
      page.drawLine({ start: { x, y: ROW_Y[5] }, end: { x, y: ROW_Y[0] }, thickness: 0.8 });
    }
    ROWS.forEach((row, r) => {
      row.forEach((cell, c) => {
        page.drawText(cell, { x: COL_X[c] + 4, y: ROW_Y[r + 1] + 8, size: 10, font });
      });
    });
  }
  writeFileSync(path, await doc.save());
}

/** The written workbook's first sheet, as text by cell address. */
async function readWorkbook(path: string): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const sheetName = Object.keys(zip.files).find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n));
  expect(sheetName).toBeTruthy();
  const sheet = await zip.file(sheetName as string)!.async('string');
  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared: string[] = [];
  if (sharedFile) {
    const xml = await sharedFile.async('string');
    for (const match of xml.matchAll(/<si>(.*?)<\/si>/gs)) {
      shared.push([...match[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => m[1]).join(''));
    }
  }
  const cells: Record<string, string> = {};
  // A string cell arrives either as an index into the shared table or inline
  // under <is><t>; a number arrives under <v> whatever the writer chose.
  for (const match of sheet.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(.*?)<\/c>/gs)) {
    const [, ref, attrs, body] = match;
    const inline = /<is>.*?<t[^>]*>(.*?)<\/t>.*?<\/is>/s.exec(body)?.[1];
    if (inline !== undefined) {
      cells[ref] = inline;
      continue;
    }
    const value = /<v>(.*?)<\/v>/s.exec(body)?.[1];
    if (value === undefined) continue;
    cells[ref] = / t="s"/.test(attrs) ? (shared[Number(value)] ?? '') : value;
  }
  return cells;
}

async function slideCount(path: string): Promise<number> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  return Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
}

describe('exporting a document to a spreadsheet, a deck and plain text', () => {
  before(async () => {
    work = mkdtempSync(join(tmpdir(), 'spectra-e2e-o9-'));
    await waitForHarness();
  });

  afterEach(async () => {
    await closeAllFiles();
  });

  it('writes the table cells to a workbook at the addresses the page laid them out', async () => {
    const src = join(work, 'table.pdf');
    await buildTablePdf(src, 1);
    await openByPaths([src]);
    const out = join(work, 'table.xlsx');

    const result = (await exportActiveAs(out, 'xlsx')) as {
      tables?: { rows: number; columns: number; evidence: string }[];
      pages_analyzed?: number[];
    };
    expect(String(result)).not.toContain('__SPECTRA_E2E_ERROR__');
    expect(result.tables).toHaveLength(1);
    expect(result.tables![0].rows).toBe(5);
    expect(result.tables![0].columns).toBe(4);
    expect(result.tables![0].evidence).toBe('ruled');

    const cells = await readWorkbook(out);
    expect(cells.A1).toBe('Region');
    expect(cells.D1).toBe('Q3');
    expect(cells.A2).toBe('North');
    // A figure comes back as a NUMBER, not as text that nobody can total.
    expect(cells.B2).toBe('1200');
    expect(cells.D5).toBe('905');
    expect(Object.keys(cells).filter((ref) => /^[A-D][1-5]$/.test(ref))).toHaveLength(20);
  });

  it('writes one slide per page, and the count is what proves it', async () => {
    const src = join(work, 'deck.pdf');
    await buildTablePdf(src, 3);
    await openByPaths([src]);
    const out = join(work, 'deck.pptx');

    const result = (await exportActiveAs(out, 'pptx')) as {
      slides?: number;
      pages_exported?: number[];
      text_boxes?: number;
    };
    expect(String(result)).not.toContain('__SPECTRA_E2E_ERROR__');
    expect(result.slides).toBe(3);
    expect(result.pages_exported).toEqual([1, 2, 3]);
    expect(result.text_boxes).toBeGreaterThan(0);
    // Read the package rather than trusting the report: this is the exact
    // shape a conversion reported as a success while writing nothing.
    expect(await slideCount(out)).toBe(3);
  });

  it('writes the document text, and separates the pages when asked', async () => {
    const src = join(work, 'text.pdf');
    await buildTablePdf(src, 2);
    await openByPaths([src]);

    const plain = join(work, 'plain.txt');
    const result = (await exportActiveAs(plain, 'txt')) as {
      characters?: number;
      pages_extracted?: number[];
    };
    expect(String(result)).not.toContain('__SPECTRA_E2E_ERROR__');
    expect(result.pages_extracted).toEqual([1, 2]);
    const body = readFileSync(plain, 'utf8');
    expect(body.startsWith('Quarterly revenue by region 1')).toBe(true);
    expect(body).toContain('1455');
    expect(body).not.toContain('\f');

    const broken = join(work, 'broken.txt');
    await exportActiveAs(broken, 'txt', { page_breaks: true });
    expect(readFileSync(broken, 'utf8').split('\f')).toHaveLength(2);
  });

  it('refuses a spreadsheet from a document with no table, and writes no file', async () => {
    const src = join(work, 'prose.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Nothing on this page resembles a table.', { x: 72, y: 700, size: 12, font });
    writeFileSync(src, await doc.save());
    await openByPaths([src]);

    const out = join(work, 'prose.xlsx');
    const result = await exportActiveAs(out, 'xlsx');
    expect(String(result)).toContain('no table was found');
    expect(() => readFileSync(out)).toThrow();
  });
});
