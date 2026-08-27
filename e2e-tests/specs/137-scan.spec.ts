import { resolve } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import {
  commitPendingEdits,
  waitForHarness,
  getState,
  invokeAppCommand,
  openByPaths,
  scanAppend,
  scanCapabilitiesRefusal,
  scanInjectDevice,
  scanListDevices,
  scanRemovePage,
  scanSaveAs,
  scanSetSource,
  scanSnapshot,
} from '../support/harness.js';

// File ▸ Create PDF from Scanner…, and the same dialog appending into an open
// document.
//
// What this spec proves and what it deliberately does not: acquisition needs a
// physical device and a driver, and a mock WIA driver would be a second
// product to maintain that proved the mock's behaviour rather than a
// scanner's. So the TRANSFER is the one thing injected — the capability report
// and the page files. Everything else is real: the empty state a scannerless
// machine actually produces, the command contract underneath it, the control
// derivation over an injected report, the scan-more list, the per-page remove,
// and both destinations through the real `create_pdf` and the real byte-only
// import machinery.

/** A PNG of a given pixel size, written by hand — no encoder dependency, and
 * SIZE is then the only difference between pages, so the assembled document's
 * geometry names which page landed where. */
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
  ihdr[8] = 8;
  ihdr[9] = 0;
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

/** One scan source, in the exact shape the device layer reports. */
function reportedSource(category: string, over: Record<string, unknown> = {}) {
  return {
    item_name: `Root\\${category}`,
    category,
    properties: [],
    resolution: { kind: 'choice', values: [150, 300, 600], current: 300 },
    optical_resolution: 600,
    color_modes: ['black_and_white', 'grayscale', 'color'],
    brightness: { kind: 'absent' },
    contrast: { kind: 'absent' },
    pages: { kind: 'span', min: 0, max: 99, step: 1, current: 0 },
    document_handling_select: { kind: 'flags', valid: 7, current: 2 },
    ...over,
  };
}

/** A flatbed-only device: no feeder, no duplex, no brightness property. */
const FLATBED_ONLY = {
  device_id: 'e2e-flatbed',
  device_name: 'E2E Flatbed 100',
  max_scan_time_ms: 60_000,
  sources: [reportedSource('flatbed', { pages: { kind: 'absent' } })],
  // The picker rows are reported, not re-derived: a flatbed device offers one
  // row and no duplex anywhere.
  source_options: [
    { id: 'flatbed', item_name: 'Root\\flatbed', document_handling: 2, feeds: false },
  ],
  document_handling: {
    capabilities: 2,
    flatbed: true,
    feeder: false,
    duplex: false,
    advanced_duplex: false,
    duplex_mode: 'none',
    flatbed_select: 2,
    feeder_select: 1,
    duplex_select: 5,
  },
};

/** A feeder device with the duplex bit and a brightness range. */
const FEEDER_DUPLEX = {
  device_id: 'e2e-feeder',
  device_name: 'E2E Feeder 200',
  max_scan_time_ms: 120_000,
  sources: [
    reportedSource('flatbed', { pages: { kind: 'absent' } }),
    reportedSource('feeder', {
      brightness: { kind: 'span', min: -1000, max: 1000, step: 1, current: 0 },
      color_modes: ['grayscale', 'color', 'auto'],
      resolution: { kind: 'span', min: 75, max: 4800, step: 1, current: 200 },
    }),
  ],
  source_options: [
    { id: 'flatbed', item_name: 'Root\\flatbed', document_handling: 2, feeds: false },
    { id: 'feeder', item_name: 'Root\\feeder', document_handling: 1, feeds: true },
    // The duplex row transfers from the FEEDER item; the duplex bit names no
    // source to take the sheet from.
    { id: 'duplex', item_name: 'Root\\feeder', document_handling: 5, feeds: true },
  ],
  document_handling: {
    capabilities: 7,
    flatbed: true,
    feeder: true,
    duplex: true,
    advanced_duplex: false,
    duplex_mode: 'duplex_bit',
    flatbed_select: 2,
    feeder_select: 1,
    duplex_select: 5,
  },
};

describe('scan', () => {
  let tmp: string;
  let pages: string[];

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-scan-'));
    // Three "acquired" pages, each a different height ascending with its
    // number, so the assembled document's geometry proves the order.
    pages = [1, 2, 3].map((n) => {
      const path = resolve(tmp, `page-000${n - 1}.png`);
      writePng(path, 200, 200 + n * 40);
      return path;
    });
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  /** Enumeration has finished when the dialog has left its `looking` phase —
   * which lands on the empty state or on a populated device picker depending
   * on what is physically attached to THIS machine. Injection replaces the
   * device either way, so a wait that insists on the empty state is a wait on
   * ambient hardware rather than on the dialog being ready. */
  async function waitForScanEnumerated(): Promise<void> {
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="scan-empty"]').isExisting()) ||
        (await $('[data-testid="scan-device"]').isExisting()),
      { timeout: 20_000, timeoutMsg: 'scan dialog never left the looking phase' },
    );
  }

  /** Whether this machine has a real scanner attached. The two tests below
   * assert what a SCANNERLESS machine produces; there is no seam to force an
   * empty backend, so the premise is established rather than assumed. */
  async function hasRealScanner(): Promise<boolean> {
    return (await scanListDevices()).scanners.length > 0;
  }

  afterEach(async () => {
    const dialog = $('[data-testid="scan-dialog"]');
    if (!(await dialog.isExisting())) return;
    const close = $('[data-testid="scan-close"]');
    if (await close.isExisting()) await close.click().catch(() => {});
    await dialog.waitForExist({ reverse: true, timeout: 10_000 }).catch(() => {});
  });

  it('opens to a named empty state on a machine with no scanner', async function () {
    this.timeout(60_000);
    await waitForHarness();
    if (await hasRealScanner()) this.skip();
    expect(await invokeAppCommand('file.createFromScanner')).toBe(true);
    const dialog = $('[data-testid="scan-dialog"]');
    await dialog.waitForExist({ timeout: 15_000 });

    // The honest empty state: a named screen with what to check and a working
    // Refresh — not a spinner, not an error toast, not a disabled dropdown.
    const EMPTY = '[data-testid="scan-empty"]';
    await $(EMPTY).waitForExist({ timeout: 20_000 });
    expect(await $(EMPTY).getText()).toContain('No scanners found');
    const refresh = $('[data-testid="scan-refresh"]');
    expect(await refresh.isExisting()).toBe(true);
    expect(await refresh.isEnabled()).toBe(true);
    expect(await $('[data-testid="scan-error"]').isExisting()).toBe(false);
    // Refresh re-enumerates and lands back on the same honest answer. The
    // re-enumeration unmounts the empty panel and mounts a new one, so the
    // selector is asked again rather than a handle from before the click.
    await refresh.click();
    await $(EMPTY).waitForExist({ timeout: 20_000 });
    expect(await $(EMPTY).isExisting()).toBe(true);
  });

  it('answers the command contract: an empty list is a result, an unknown id refuses by name', async function () {
    this.timeout(60_000);
    await waitForHarness();
    // Enumeration RESOLVES rather than rejecting. A rejection would make the
    // empty state unreachable. On a scannerless machine that resolution is an
    // empty array with no preselected default; the emptiness is the ambient
    // fact, the resolution is the contract.
    const list = await scanListDevices();
    expect(Array.isArray(list.scanners)).toBe(true);
    if (list.scanners.length === 0) {
      // A stored last-used id that no longer enumerates is dropped rather than
      // preselecting a device that is not there.
      expect(list.default).toBe(null);
    }

    // The unknown-id refusal is machine-independent and is asserted always.
    const refusal = await scanCapabilitiesRefusal('no-such-device');
    expect(refusal).not.toBe(null);
    // A stable KEY beside its English sentence: the renderer renders the key,
    // and a bare String() on this error would have yielded "[object Object]".
    expect(typeof refusal?.key).toBe('string');
    expect(refusal?.key.startsWith('scan.')).toBe(true);
    expect((refusal?.message ?? '').length).toBeGreaterThan(0);
  });

  it('derives every control from the reported capabilities', async function () {
    this.timeout(60_000);
    await waitForHarness();
    expect(await invokeAppCommand('file.createFromScanner')).toBe(true);
    await $('[data-testid="scan-dialog"]').waitForExist({ timeout: 15_000 });
    await waitForScanEnumerated();

    // A flatbed-only device: one source row, no duplex offer anywhere, and no
    // brightness slider because the device reported no brightness property.
    await scanInjectDevice(FLATBED_ONLY);
    await browser.waitUntil(async () => (await scanSnapshot())?.deviceName === 'E2E Flatbed 100', {
      timeout: 10_000,
    });
    let snap = (await scanSnapshot())!;
    expect(snap.sources).toEqual(['flatbed']);
    expect(snap.brightness).toBe('absent');
    // A listed resolution renders exactly its values — never a hard-coded
    // 100/200/300/600.
    expect(snap.dpiControl).toEqual({ kind: 'choice', values: [150, 300, 600], current: 300 });
    expect(snap.colorModes).toEqual(['black_and_white', 'grayscale', 'color']);
    // The device reported no feeder, so there is no page-count control at all.
    expect(await $('[data-testid="scan-pages"]').isExisting()).toBe(false);
    expect(await $('[data-testid="scan-source"]').isExisting()).toBe(false);

    // A feeder device with the duplex bit: three source rows, and switching to
    // the feeder re-derives its OWN controls.
    await scanInjectDevice(FEEDER_DUPLEX);
    await browser.waitUntil(async () => (await scanSnapshot())?.deviceName === 'E2E Feeder 200', {
      timeout: 10_000,
    });
    snap = (await scanSnapshot())!;
    expect(snap.sources).toEqual(['flatbed', 'feeder', 'duplex']);
    await scanSetSource('feeder');
    await browser.waitUntil(async () => (await scanSnapshot())?.source === 'feeder', {
      timeout: 10_000,
    });
    snap = (await scanSnapshot())!;
    // The feeder's own report: a brightness span the flatbed did not have,
    // autodetect colour the flatbed did not list, and a range too wide to
    // enumerate, which becomes a bounded number field rather than a 4726-row
    // dropdown.
    expect(snap.brightness).toBe('number');
    expect(snap.colorModes).toEqual(['grayscale', 'color', 'auto']);
    expect(snap.dpiControl).toEqual({ kind: 'number', min: 75, max: 4800, step: 1, current: 200 });
    expect(await $('[data-testid="scan-pages"]').isExisting()).toBe(true);
    // "Every page in the feeder" is offered because the device takes zero for
    // it; a device that would not is what the offer's absence protects.
    expect(await $('[data-testid="scan-pages-all"]').isExisting()).toBe(true);
    expect(await $('[data-testid="scan-advanced-toggle"]').isExisting()).toBe(true);
  });

  it('offers the pages that completed when a run stopped part way', async function () {
    this.timeout(120_000);
    await waitForHarness();
    expect(await invokeAppCommand('file.createFromScanner')).toBe(true);
    await $('[data-testid="scan-dialog"]').waitForExist({ timeout: 15_000 });
    await waitForScanEnumerated();

    // Two of a five-page stack arrived before the run stopped. A cancelled run
    // is a RESULT, so the two are offered.
    await scanInjectDevice(FEEDER_DUPLEX, pages.slice(0, 2));
    await browser.waitUntil(async () => ((await scanSnapshot())?.pageIds.length ?? 0) === 2, {
      timeout: 10_000,
    });
    const review = $('[data-testid="scan-review"]');
    expect(await review.isExisting()).toBe(true);
    expect((await $$('[data-testid="scan-page"]').getElements()).length).toBe(2);
    // Save is offered for a partial result, which is the whole point of
    // keeping the pages.
    expect(await $('[data-testid="scan-save"]').isExisting()).toBe(true);
  });

  it('builds a new document through the real create_pdf, in scan order', async function () {
    this.timeout(180_000);
    await waitForHarness();
    expect(await invokeAppCommand('file.createFromScanner')).toBe(true);
    await $('[data-testid="scan-dialog"]').waitForExist({ timeout: 15_000 });
    await waitForScanEnumerated();

    await scanInjectDevice(FLATBED_ONLY, pages);
    await browser.waitUntil(async () => ((await scanSnapshot())?.pageIds.length ?? 0) === 3, {
      timeout: 10_000,
    });

    // Per-page remove: drop the middle page and prove the other two survive
    // it, in order.
    const before = (await scanSnapshot())!;
    await scanRemovePage(before.pageIds[1]);
    await browser.waitUntil(async () => ((await scanSnapshot())?.pageIds.length ?? 0) === 2, {
      timeout: 10_000,
    });
    const kept = (await scanSnapshot())!;
    expect(kept.pagePaths).toEqual([before.pagePaths[0], before.pagePaths[2]]);

    const output = resolve(tmp, 'scanned.pdf');
    expect(await scanSaveAs(output)).toBe(output);
    await browser.waitUntil(() => Promise.resolve(existsSync(output)), { timeout: 60_000 });

    // On disk, and in the order the pages were scanned: page 1 is the shorter
    // image and page 3 the taller, which is what the removal left behind.
    const doc = await PDFDocument.load(readFileSync(output));
    expect(doc.getPageCount()).toBe(2);
    const heights = doc.getPages().map((p) => p.getHeight());
    expect(heights[1]).toBeGreaterThan(heights[0]);
    // The dialog closes once the result is open, and the document is the one
    // the open funnel opened.
    await $('[data-testid="scan-dialog"]').waitForExist({ reverse: true, timeout: 20_000 });
  });

  it('appends into the open document through the real import machinery', async function () {
    this.timeout(180_000);
    await waitForHarness();
    // A two-page document to append into.
    const base = await PDFDocument.create();
    base.addPage([300, 400]);
    base.addPage([300, 400]);
    const basePath = resolve(tmp, 'base.pdf');
    writeFileSync(basePath, await base.save());
    // The document built by the previous case is still open and also has two
    // pages, so the wait below names the FILE, not just a page count.
    await openByPaths([basePath]);
    await browser.waitUntil(
      async () => {
        const state = await getState();
        // By NAME, not by the string this spec wrote: paths are canonicalised
        // at the Rust boundary, so the open file's spelling is the canonical
        // one and need not equal the one handed to the open funnel.
        return (
          state.activeFile?.path.toLowerCase().endsWith('base.pdf') === true &&
          state.activeFile?.pageCount === 2
        );
      },
      { timeout: 15_000, timeoutMsg: 'the base document never opened' },
    );
    // The menu item is gated on an insertion ANCHOR, which needs the async
    // workspace indexing to have produced a document for the file — an open
    // file with a page count is not yet a document to insert into.
    await browser.waitUntil(async () => invokeAppCommand('document.insertFromScanner'), {
      timeout: 15_000,
      timeoutMsg: 'Insert ▸ From Scanner never became available',
    });
    await $('[data-testid="scan-dialog"]').waitForExist({ timeout: 15_000 });
    await waitForScanEnumerated();

    await scanInjectDevice(FLATBED_ONLY, pages);
    await browser.waitUntil(async () => ((await scanSnapshot())?.pageIds.length ?? 0) === 3, {
      timeout: 10_000,
    });
    // The append assembles beside the destination's working copy — the
    // dialog chooses that path, not the spec.
    expect(await scanAppend()).not.toBe(null);
    await $('[data-testid="scan-dialog"]').waitForExist({ reverse: true, timeout: 30_000 });

    // The pages land as PAGE-TIER work, which is the point of routing an
    // append through the byte-only import machinery: they live in the
    // workspace until committed, and committing writes the WORKING COPY —
    // the user's own file is untouched until they save.
    //
    // The commit is retried because the import dispatch settles a beat after
    // the append resolves, and a commit that ran before it had nothing
    // pending to write.
    let workingPath = '';
    await browser.waitUntil(
      async () => {
        await commitPendingEdits();
        const state = await getState();
        workingPath = state.activeFile?.workingPath ?? '';
        if (!workingPath || !existsSync(workingPath)) return false;
        return (await PDFDocument.load(readFileSync(workingPath))).getPageCount() === 5;
      },
      { timeout: 40_000, timeoutMsg: 'the scanned pages never reached the open document' },
    );
    // The three that arrived are the scanned ones — each a different height,
    // ascending in scan order.
    const committed = await PDFDocument.load(readFileSync(workingPath));
    const heights = committed.getPages().map((page) => page.getHeight());
    expect(heights[3]).toBeGreaterThan(heights[2]);
    expect(heights[4]).toBeGreaterThan(heights[3]);
    // Nothing was written over the file the user opened.
    expect((await PDFDocument.load(readFileSync(basePath))).getPageCount()).toBe(2);
  });
});
