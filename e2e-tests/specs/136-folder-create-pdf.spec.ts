import { resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  invokeAppCommand,
  folderCreatePdfSetFolders,
  folderCreatePdfRun,
  folderCreatePdfSnapshot,
} from '../support/harness.js';

// Tools ▸ One PDF per Folder: a tree of scan folders → one PDF per directory,
// pages in page-NUMBER order.
//
// The ordering assertion is the one that matters and it is checked ON DISK
// rather than in the preview: `page1 … page10` sorted as text puts page 10
// second, and nothing about the resulting document would say the order was
// chosen rather than observed. Each page image carries a different SIZE, so
// the assembled page geometry names which image landed where without needing
// to recognise anything.

/** A PNG of a given pixel size, written by hand — no encoder dependency: an
 * 8-bit greyscale PNG with one IDAT is short enough to build here, and using
 * the same builder for every page keeps SIZE the only difference between
 * them. */
function writePng(path: string, width: number, height: number): void {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  // One filter byte per row, then `width` white samples.
  const raw = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe('one PDF per folder', () => {
  let tmp: string;
  let src: string;
  let dest: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-folder-create-pdf-'));
    src = resolve(tmp, 'scans');
    dest = resolve(tmp, 'assembled');
    // `invoice` holds ten pages whose names sort WRONG as text. Each is a
    // different height, ascending with the page number, so the assembled
    // document's page geometry proves the order.
    mkdirSync(resolve(src, 'invoice'), { recursive: true });
    for (let n = 1; n <= 10; n++) {
      writePng(resolve(src, 'invoice', `page${n}.png`), 100, 100 + n * 10);
    }
    // A nested folder, to prove the walk descends and mirrors.
    mkdirSync(resolve(src, 'invoice', 'sub', 'letter'), { recursive: true });
    writePng(resolve(src, 'invoice', 'sub', 'letter', 'a.png'), 120, 160);
    writePng(resolve(src, 'invoice', 'sub', 'letter', 'b.png'), 120, 160);
    // A folder with nothing convertible produces nothing and is not an error.
    mkdirSync(resolve(src, 'notes'), { recursive: true });
    writeFileSync(resolve(src, 'notes', 'readme.md'), 'not a picture');
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(async () => {
    const dialog = $('[data-testid="folder-create-pdf-dialog"]');
    if (!(await dialog.isExisting())) return;
    for (const id of ['folder-create-pdf-close', 'folder-create-pdf-x']) {
      const button = $(`[data-testid="${id}"]`);
      if (!(await button.isExisting())) continue;
      await button.click().catch(() => {});
      break;
    }
    await dialog.waitForExist({ reverse: true, timeout: 10_000 }).catch(() => {});
  });

  it('assembles each folder into one PDF, in page-number order, mirrored', async function () {
    this.timeout(180_000);
    await waitForHarness();

    expect(await invokeAppCommand('tools.folderCreatePdf')).toBe(true);
    await $('[data-testid="folder-create-pdf-dialog"]').waitForDisplayed({ timeout: 10_000 });

    await folderCreatePdfSetFolders(src, dest);
    // Two folders hold pictures; `notes` holds none and is absent — a folder
    // with nothing to assemble is not a row and not an error.
    await browser.waitUntil(
      async () => (await folderCreatePdfSnapshot())?.folderCount === 2,
      {
        timeout: 20_000,
        timeoutMsg:
          'the walk never found the 2 picture folders — snapshot: ' +
          JSON.stringify(await folderCreatePdfSnapshot()),
      },
    );
    // The preview IS the run: the folders it will build, in order.
    await expect($('[data-testid="folder-create-pdf-preview"]')).toBeDisplayed();

    await folderCreatePdfRun();
    await browser.waitUntil(async () => (await folderCreatePdfSnapshot())?.phase === 'done', {
      timeout: 150_000,
      interval: 1_000,
      timeoutMsg:
        'the run never reached done — snapshot: ' +
        JSON.stringify(await folderCreatePdfSnapshot()),
    });

    const snapshot = await folderCreatePdfSnapshot();
    const results = snapshot!.report!.results;
    expect(snapshot!.report!.cancelled).toBe(false);
    expect(results.every((r) => r.status === 'built')).toBe(true);
    const invoice = results.find((r) => r.rel === 'invoice')!;
    expect(invoice.files).toBe(10);
    expect(invoice.pages).toBe(10);

    // ON DISK: the PDF takes the FOLDER'S place in the mirrored tree.
    const invoicePdf = resolve(dest, 'invoice.pdf');
    const letterPdf = resolve(dest, 'invoice', 'sub', 'letter.pdf');
    expect(existsSync(invoicePdf)).toBe(true);
    expect(existsSync(letterPdf)).toBe(true);
    expect(existsSync(resolve(dest, 'notes.pdf'))).toBe(false);

    // The ORDER, read back independently. Page n was built from an image
    // 100 + n*10 pixels tall, so the page heights must ascend — which they do
    // not under a lexicographic sort, where page10 would be second.
    const doc = await PDFDocument.load(readFileSync(invoicePdf));
    expect(doc.getPageCount()).toBe(10);
    const heights = doc.getPages().map((p) => p.getSize().height);
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThan(heights[i - 1]);
    }

    // Sources untouched: the run reads them and writes elsewhere.
    expect(existsSync(resolve(src, 'invoice', 'page1.png'))).toBe(true);
    expect(existsSync(resolve(src, 'invoice.pdf'))).toBe(false);

    // The run leaves a durable record — the dialog's report dies with it.
    const logPath = snapshot!.logPath;
    expect(logPath).toBeTruthy();
    expect(existsSync(logPath!)).toBe(true);
    const log = readFileSync(logPath!, 'utf8');
    expect(log).toContain('Spectra PDF — one PDF per folder log');
    expect(log).toContain(src);
    expect(log).toContain('Result:       completed');
    expect(log).toMatch(/\[built] +invoice -> invoice\.pdf — 10 file\(s\), 10 page\(s\)/);

    await $('[data-testid="folder-create-pdf-close"]').click();
  });

  it('refuses a destination inside the source folder', async () => {
    await waitForHarness();
    await invokeAppCommand('tools.folderCreatePdf');
    await $('[data-testid="folder-create-pdf-dialog"]').waitForDisplayed({ timeout: 10_000 });

    await folderCreatePdfSetFolders(src, resolve(src, 'nested-out'));
    await $('[data-testid="folder-create-pdf-conflict"]').waitForDisplayed({ timeout: 10_000 });
    // Otherwise the run's own outputs join the tree it is walking.
    expect(await $('[data-testid="folder-create-pdf-run"]').isEnabled()).toBe(false);

    await $('[data-testid="folder-create-pdf-x"]').click();
  });

  it('says so when nothing under the tree can be assembled', async () => {
    await waitForHarness();
    const bare = resolve(tmp, 'bare');
    mkdirSync(resolve(bare, 'empty'), { recursive: true });

    await invokeAppCommand('tools.folderCreatePdf');
    await $('[data-testid="folder-create-pdf-dialog"]').waitForDisplayed({ timeout: 10_000 });
    await folderCreatePdfSetFolders(bare, dest);

    await $('[data-testid="folder-create-pdf-empty"]').waitForDisplayed({ timeout: 15_000 });
    expect(await $('[data-testid="folder-create-pdf-run"]').isEnabled()).toBe(false);

    await $('[data-testid="folder-create-pdf-x"]').click();
  });
});
