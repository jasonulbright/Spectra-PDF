// Exporting a FOLDER of documents nobody opened, twice over, into two mirror
// trees — and a file the target cannot be produced from, which is a RESULT.
//
// 117 covers the single-document export doors and 119 covers the folder mirror
// for a different tool; neither joins them. The assertions only this spec can
// make are that the mirror carries files with real CONTENT at the target's own
// extension and at the source's tree position, that a document with nothing the
// target can use reports its refusal against its own row instead of ending the
// run, that the run log names both outcomes, and that the ORIGINALS are
// byte-identical afterwards.
import { resolve } from 'node:path';
import { readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  waitForHarness,
  invokeAppCommand,
  closeAllFiles,
  folderExportSetFolders,
  folderExportSetFormat,
  folderExportRun,
  folderExportSnapshot,
} from '../support/harness.js';

/** A page whose text sits on a grid — rows and columns the table detection can
 * find, so the spreadsheet target has something to produce. */
async function makeTable(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const columns = [72, 240, 420];
  const rows = [700, 670, 640, 610, 580];
  const cells = [
    ['Region', 'Units', 'Revenue'],
    ['North', '1200', '48000'],
    ['South', '900', '36000'],
    ['East', '1450', '58000'],
    ['West', '1100', '44000'],
  ];
  rows.forEach((y, r) => {
    columns.forEach((x, c) => {
      page.drawText(cells[r][c], { x, y, size: 11, font, color: rgb(0, 0, 0) });
    });
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, await doc.save());
}

/** A page carrying no text at all: a filled rectangle and nothing else. The
 * spreadsheet target has nothing to find in it, which is the refusal this spec
 * needs to be a per-file RESULT. */
async function makePicture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 100, y: 300, width: 400, height: 300, color: rgb(0.2, 0.4, 0.8) });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, await doc.save());
}

async function waitForDone(timeout: number): Promise<void> {
  await browser.waitUntil(async () => (await folderExportSnapshot())?.phase === 'done', {
    timeout,
    interval: 500,
    timeoutMsg:
      'the sweep never finished — snapshot: ' + JSON.stringify(await folderExportSnapshot()),
  });
}

describe('Export a folder', () => {
  let tmp: string;
  let src: string;
  let textDest: string;
  let sheetDest: string;
  let alpha: string;
  let beta: string;
  let picture: string;
  let originals: { alpha: Buffer; beta: Buffer; picture: Buffer };

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-o13-'));
    src = resolve(tmp, 'source');
    textDest = resolve(tmp, 'as-text');
    sheetDest = resolve(tmp, 'as-sheets');
    mkdirSync(resolve(src, 'sub'), { recursive: true });
    alpha = resolve(src, 'alpha.pdf');
    beta = resolve(src, 'sub', 'beta.pdf');
    picture = resolve(src, 'picture.pdf');
    await makeTable(alpha);
    await makeTable(beta);
    await makePicture(picture);
    originals = {
      alpha: readFileSync(alpha),
      beta: readFileSync(beta),
      picture: readFileSync(picture),
    };
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a plain-text mirror at the source tree positions, and never touches the originals', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await closeAllFiles();

    // No document is open, and none is opened by any of this — the command is
    // enabled regardless, like the other folder tools.
    expect(await invokeAppCommand('tools.folderExport')).toBe(true);
    await $('[data-testid="folder-export-dialog"]').waitForDisplayed({ timeout: 10_000 });

    await folderExportSetFolders(src, textDest);
    await browser.waitUntil(async () => (await folderExportSnapshot())?.fileCount === 3, {
      timeout: 20_000,
      timeoutMsg: 'enumeration never found the 3 fixture PDFs',
    });

    await folderExportSetFormat('txt');
    await folderExportRun();
    await waitForDone(120_000);

    const report = (await folderExportSnapshot())?.report;
    expect(report?.cancelled).toBe(false);
    const byRel = new Map((report?.results ?? []).map((r) => [r.rel, r]));
    expect(byRel.get('alpha.pdf')?.status).toBe('exported');
    expect(byRel.get('sub\\beta.pdf')?.status).toBe('exported');
    // The row is keyed by the SOURCE's tree position and names the output.
    expect(byRel.get('sub\\beta.pdf')?.out).toBe('sub\\beta.txt');

    const alphaTxt = resolve(textDest, 'alpha.txt');
    const betaTxt = resolve(textDest, 'sub', 'beta.txt');
    expect(existsSync(alphaTxt)).toBe(true);
    expect(existsSync(betaTxt)).toBe(true);
    // CONTENT, not merely a file: a zero-byte output passing an existence
    // check is the failure this assertion exists to make impossible.
    expect(readFileSync(alphaTxt, 'utf8')).toContain('Revenue');
    expect(readFileSync(betaTxt, 'utf8')).toContain('North');
    // The PDF is never mirrored beside its export.
    expect(existsSync(resolve(textDest, 'alpha.pdf'))).toBe(false);

    // The page with no text is a RESULT carrying its reason, not a stopped run.
    expect(byRel.get('picture.pdf')?.status).toBe('skipped');
    expect(byRel.get('picture.pdf')?.reason ?? '').not.toBe('');
    expect(existsSync(resolve(textDest, 'picture.txt'))).toBe(false);

    // The originals are untouched, byte for byte.
    expect(readFileSync(alpha).equals(originals.alpha)).toBe(true);
    expect(readFileSync(beta).equals(originals.beta)).toBe(true);
    expect(readFileSync(picture).equals(originals.picture)).toBe(true);

    // The run leaves an artefact naming both outcomes.
    const logPath = (await folderExportSnapshot())?.logPath;
    expect(logPath).toBeTruthy();
    const log = readFileSync(logPath!, 'utf8');
    expect(log).toContain('Format:       txt');
    expect(log).toContain('[exported]  alpha.pdf -> alpha.txt');
    expect(log).toContain('[skipped]   picture.pdf');
  });

  it('exports the same folder again to a spreadsheet, into its own mirror', async function () {
    this.timeout(180_000);
    await waitForHarness();

    // The dialog is still open on its report; the second run starts from setup.
    await $('[data-testid="folder-export-close"]').click();
    expect(await invokeAppCommand('tools.folderExport')).toBe(true);
    await $('[data-testid="folder-export-dialog"]').waitForDisplayed({ timeout: 10_000 });

    await folderExportSetFolders(src, sheetDest);
    await browser.waitUntil(async () => (await folderExportSnapshot())?.fileCount === 3, {
      timeout: 20_000,
      timeoutMsg: 'enumeration never found the 3 fixture PDFs',
    });

    await folderExportSetFormat('xlsx');
    await folderExportRun();
    await waitForDone(120_000);

    const report = (await folderExportSnapshot())?.report;
    const byRel = new Map((report?.results ?? []).map((r) => [r.rel, r]));
    expect(byRel.get('alpha.pdf')?.status).toBe('exported');
    expect(byRel.get('sub\\beta.pdf')?.out).toBe('sub\\beta.xlsx');

    const alphaXlsx = resolve(sheetDest, 'alpha.xlsx');
    const betaXlsx = resolve(sheetDest, 'sub', 'beta.xlsx');
    expect(existsSync(alphaXlsx)).toBe(true);
    expect(existsSync(betaXlsx)).toBe(true);
    // A workbook is a zip package; a produced file that carries nothing would
    // still exist, so the check is that it opens as one and is not empty.
    expect(statSync(alphaXlsx).size).toBeGreaterThan(1000);
    expect(readFileSync(alphaXlsx).subarray(0, 2).toString('latin1')).toBe('PK');

    // The first run's tree is untouched by the second: two targets, two mirrors.
    expect(existsSync(resolve(textDest, 'alpha.txt'))).toBe(true);
    expect(existsSync(resolve(sheetDest, 'alpha.txt'))).toBe(false);

    // And the originals are still byte-identical after a second sweep.
    expect(readFileSync(alpha).equals(originals.alpha)).toBe(true);
    expect(readFileSync(beta).equals(originals.beta)).toBe(true);

    await $('[data-testid="folder-export-close"]').click();
  });
});
