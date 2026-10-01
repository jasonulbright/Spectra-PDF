import { resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { answerNextSaveDialog, requirePlatformFeatures, waitForHarness } from '../support/harness.js';

// The File Explorer verbs, through the first-launch door.
//
// The shell handler writes the selection to a one-shot handoff file and starts
// the app with `--shell-action <file>`. Single-instance forwarding is off under
// SPECTRAPDF_E2E, so each case writes the handoff the handler would write and
// relaunches the app with that argument. What it proves: the selection opens
// the right dialog in folder name order, per-file Convert never replaces an
// existing file, and Combine's list reorders by pointer drag before the write.

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const SAMPLE_PDF = resolve(__dirname, '..', '..', 'tests', 'fixtures', 'sample.pdf');

/** A small grayscale PNG, twice as wide as it is tall. */
function writePng(path: string, width = 400, height = 200): void {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y += 1) raw[y * (width + 1)] = 0;
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

/** The handoff the shell handler writes, in the folder the app accepts it from:
 * `Temp\spectrapdf\shell-handoff` under the user's Local AppData folder,
 * whatever TMP says. */
function writeHandoff(action: 'convert' | 'combine', paths: string[]): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA is not set');
  const dir = resolve(localAppData, 'Temp', 'spectrapdf', 'shell-handoff');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${randomBytes(16).toString('hex')}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, action, paths, skipped: 0 }), 'utf8');
  return file;
}

async function launchWith(handoff: string): Promise<void> {
  const requested = browser.requestedCapabilities as Record<string, { application: string }>;
  const application = requested['tauri:options'].application;
  await browser.reloadSession({
    'tauri:options': { application, args: ['--shell-action', handoff] },
  } as WebdriverIO.Capabilities);
  await waitForHarness();
}

async function pageBoxes(path: string): Promise<number[][]> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const boxes: number[][] = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const [, , width, height] = (await pdf.getPage(i)).view as number[];
    boxes.push([width, height]);
  }
  await pdf.loadingTask.destroy();
  return boxes;
}

const names = async (selector: string): Promise<string[]> =>
  $$(selector).map((el) => el.getText());

describe('File Explorer verbs', () => {
  let tmp: string;

  before(async function () {
    await requirePlatformFeatures(this, 'explorerMenu');
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-shell-verbs-'));
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('Convert lists the selection in name order and writes one PDF per file, replacing nothing', async function () {
    this.timeout(180_000);
    for (const name of ['img1.png', 'img2.png', 'img10.png']) writePng(resolve(tmp, name));
    // A name already taken beside a source: its output must get a number.
    copyFileSync(SAMPLE_PDF, resolve(tmp, 'img1.pdf'));
    const before = readFileSync(resolve(tmp, 'img1.pdf'));

    await launchWith(
      writeHandoff('convert', ['img10.png', 'img2.png', 'img1.png'].map((n) => resolve(tmp, n))),
    );
    await $('[data-testid="create-pdf-dialog"]').waitForDisplayed({ timeout: 15_000 });
    expect(await names('[data-testid="create-pdf-row-name"]')).toEqual(['img1.png', 'img2.png', 'img10.png']);
    expect(await $('[data-testid="create-pdf-output-perfile"]').isSelected()).toBe(true);

    await $('[data-testid="create-pdf-convert"]').click();
    await browser.waitUntil(
      async () =>
        (await $$('[data-testid="create-pdf-perfile-row"]').length) === 3 &&
        !(await $('[data-testid="create-pdf-progress"]').isExisting()),
      { timeout: 120_000, timeoutMsg: 'the per-file run never finished' },
    );
    const rowAttr = (name: string): Promise<string[]> =>
      $$('[data-testid="create-pdf-perfile-row"]').map(async (row) => (await row.getAttribute(name)) ?? '');
    expect(await rowAttr('data-state')).toEqual(['built', 'built', 'built']);
    const outputs = await rowAttr('data-output');
    expect(outputs.map((o) => o.split(/[\\/]/).pop())).toEqual(['img1 (2).pdf', 'img2.pdf', 'img10.pdf']);
    for (const output of outputs) expect(existsSync(output)).toBe(true);
    expect(readFileSync(resolve(tmp, 'img1.pdf')).equals(before)).toBe(true);
  });

  it('Combine lists the selection in name order, reorders by drag, and writes that order', async function () {
    this.timeout(180_000);
    writePng(resolve(tmp, 'a-scan.png'));
    copyFileSync(SAMPLE_PDF, resolve(tmp, 'b-doc.pdf'));
    const pdfPages = (await pageBoxes(resolve(tmp, 'b-doc.pdf'))).length;

    await launchWith(writeHandoff('combine', [resolve(tmp, 'b-doc.pdf'), resolve(tmp, 'a-scan.png')]));
    await $('[data-testid="combine-dialog"]').waitForDisplayed({ timeout: 15_000 });
    expect(await names('[data-testid="combine-row-name"]')).toEqual(['a-scan.png', 'b-doc.pdf']);
    expect(await $('[data-testid="combine-target-new"]').isSelected()).toBe(true);

    // Drag the second row's grip above the first row's midpoint.
    const grips = await $$('[data-testid="combine-row-grip"]');
    const firstRow = (await $$('[data-testid="combine-row"]'))[0];
    const { height } = await firstRow.getSize();
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ origin: grips[1] })
      .down()
      .pause(100)
      .move({ origin: firstRow, x: 0, y: -Math.floor(height / 2) + 2, duration: 200 })
      .pause(100)
      .up()
      .perform();
    await browser.waitUntil(
      async () => (await names('[data-testid="combine-row-name"]'))[0] === 'b-doc.pdf',
      { timeout: 5_000, timeoutMsg: 'the pointer drag did not reorder the list' },
    );

    const out = resolve(tmp, 'combined.pdf');
    await answerNextSaveDialog(out);
    await $('[data-testid="combine-run"]').click();
    await $('[data-testid="combine-done"]').waitForDisplayed({ timeout: 120_000 });

    const boxes = await pageBoxes(out);
    expect(boxes.length).toBe(pdfPages + 1);
    const [lastWidth, lastHeight] = boxes[boxes.length - 1];
    expect(lastWidth / lastHeight).toBeCloseTo(2, 1);
    const [firstWidth, firstHeight] = boxes[0];
    expect(firstWidth / firstHeight).not.toBeCloseTo(2, 1);
  });
});
