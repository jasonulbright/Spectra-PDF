// Reviewing detected tables before the spreadsheet is written.
//
// The assertions that matter are the ones a unit test cannot make:
//   · detection draws the tables on the PAGE and writes nothing,
//   · a rejected table does not reach the workbook,
//   · a moved column boundary changes the CELLS that come back out, which is
//     the whole point of letting one be moved,
//   · and the review's mode belongs to no tool, so opening one disarms it.
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  focusTab,
  invokeAppCommand,
  closeAllFiles,
  tableReviewList,
  tableReviewToggle,
  tableReviewMoveColumn,
  tableReviewExport,
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

const SECOND = [
  ['Item', 'Team', 'State'],
  ['Alpha', 'Dana', 'open'],
  ['Beta', 'Ravi', 'closed'],
  ['Gamma', 'Iris', 'open'],
];
const SECOND_X = [72, 260, 420];
const SECOND_Y = [520, 496, 472, 448, 424];

/** One page carrying two ruled tables with a line of prose between them. */
async function buildTwoTablePdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
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
  page.drawText('Prose between the two tables goes here.', {
    x: 72, y: 552, size: 10, font,
  });
  SECOND.forEach((row, r) => {
    row.forEach((cell, c) => {
      page.drawText(cell, { x: SECOND_X[c] + 4, y: SECOND_Y[r + 1] + 8, size: 10, font });
    });
  });
  writeFileSync(path, await doc.save());
}

/** The written workbook's sheets, each as text by cell address. The parse is
 *  spec 117's, widened from the first sheet to all of them. */
async function readWorkbook(path: string): Promise<Record<string, string>[]> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const shared: string[] = [];
  const sharedFile = zip.file('xl/sharedStrings.xml');
  if (sharedFile) {
    const xml = await sharedFile.async('string');
    for (const match of xml.matchAll(/<si>(.*?)<\/si>/gs)) {
      shared.push([...match[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => m[1]).join(''));
    }
  }
  const names = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();
  const sheets: Record<string, string>[] = [];
  for (const name of names) {
    const xml = await zip.file(name)!.async('string');
    const cells: Record<string, string> = {};
    for (const match of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(.*?)<\/c>/gs)) {
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
    sheets.push(cells);
  }
  return sheets;
}

async function clickEl(selector: string): Promise<void> {
  const el = await $(selector);
  await el.waitForExist({ timeout: 20_000 });
  await browser.execute((s: string) => {
    const node = document.querySelector(s) as HTMLElement | null;
    node?.scrollIntoView({ block: 'center' });
    node?.click();
  }, selector);
}

async function overlayCount(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-testid^="table-region-"]').length,
  );
}

async function pdfPageCount(path: string): Promise<number> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)), {
    ignoreEncryption: true,
  });
  return doc.getPageCount();
}

describe('Table review before a spreadsheet export', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-o12-'));
    source = resolve(tmp, 'two-tables.pdf');
    await buildTwoTablePdf(source);
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('draws both detected tables on the page and writes nothing to the PDF', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('canvas');
    await focusTab({ doc: source });
    const before = readFileSync(source);

    expect(await invokeAppCommand('tools.panel.tablereview')).toBe(true);
    await $('[data-testid="table-review-panel"]').waitForDisplayed({ timeout: 20_000 });

    await clickEl('[data-testid="table-review-detect"]');
    await browser.waitUntil(async () => (await tableReviewList()).length === 2, {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: 'detection never produced the two tables on the page',
    });

    const found = await tableReviewList();
    expect(found.map((r) => [r.rows, r.columns.length])).toEqual([[5, 4], [4, 3]]);
    // Nothing is accepted for the reviewer, and the page carries both frames.
    expect(found.every((r) => !r.accepted)).toBe(true);
    await browser.waitUntil(async () => (await overlayCount()) === 2, {
      timeout: 20_000,
      interval: 200,
      timeoutMsg: 'the detected tables never drew on the page',
    });

    // The whole safety property: a detector ran over the document and the
    // document is byte-identical.
    expect(Buffer.compare(before, readFileSync(source))).toBe(0);
    expect(await pdfPageCount(source)).toBe(1);
  });

  it('leaves a rejected table out of the workbook', async () => {
    const out = resolve(tmp, 'second-only.xlsx');
    const found = await tableReviewList();
    await tableReviewToggle(found[1].id);

    const result = (await tableReviewExport(out)) as { tables?: unknown[] };
    expect(String(result)).not.toContain('__SPECTRA_E2E_ERROR__');
    expect(result.tables?.length).toBe(1);

    const sheets = await readWorkbook(out);
    expect(sheets.length).toBe(1);
    expect(sheets[0].A1).toBe('Item');
    expect(sheets[0].C4).toBe('open');
    // The rejected table's own heading is nowhere in the workbook.
    expect(Object.values(sheets[0])).not.toContain('Region');
  });

  it('writes the cells the moved column boundary produces', async () => {
    const plain = resolve(tmp, 'as-detected.xlsx');
    const moved = resolve(tmp, 'boundary-moved.xlsx');
    const found = await tableReviewList();
    // Swap the accepted table: the first one, whose four columns are the ones
    // the boundary drag is measured against.
    await tableReviewToggle(found[1].id);
    await tableReviewToggle(found[0].id);

    expect(String(await tableReviewExport(plain))).not.toContain('__SPECTRA_E2E_ERROR__');
    const asDetected = (await readWorkbook(plain))[0];
    expect([asDetected.A1, asDetected.B1, asDetected.C1]).toEqual(['Region', 'Q1', 'Q2']);

    // Push the second boundary halfway to the third: the Q1 cells now sit
    // left of it, so they fall back into the first column and the second is
    // left empty. Measured against the table's OWN reported boundaries, never
    // against the page coordinates the fixture was drawn at.
    const { columns } = found[0];
    await tableReviewMoveColumn(found[0].id, 1, (columns[1] + columns[2]) / 2);
    expect(String(await tableReviewExport(moved))).not.toContain('__SPECTRA_E2E_ERROR__');

    const after = (await readWorkbook(moved))[0];
    expect(after.A1).toBe('Region Q1');
    expect(after.B1).toBeUndefined();
    expect(after.C1).toBe('Q2');
  });

  it('refuses to write a workbook when nothing is accepted', async () => {
    const found = await tableReviewList();
    for (const region of found) {
      if (region.accepted) await tableReviewToggle(region.id);
    }
    const out = resolve(tmp, 'nothing.xlsx');
    expect(String(await tableReviewExport(out))).toContain('__SPECTRA_E2E_ERROR__');
    expect(existsSync(out)).toBe(false);
  });

  it('disarms the review when another tool opens, because the mode belongs to no tool', async () => {
    expect(await overlayCount()).toBe(2);
    // Opening any other tool routes through the one place a mode is armed, so
    // a review left showing cannot go live over the next tool's page.
    expect(await invokeAppCommand('tools.panel.prepareform')).toBe(true);
    await browser.waitUntil(async () => (await overlayCount()) === 0, {
      timeout: 20_000,
      interval: 200,
      timeoutMsg: 'the review overlays survived another tool opening',
    });
    // The regions themselves are still held — opening another tool put the
    // page down, it did not throw the review away.
    expect((await tableReviewList()).length).toBe(2);
  });
});
