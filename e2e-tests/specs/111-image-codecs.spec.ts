// The viewer decodes the filters scanners and fax gateways write.
//
// pdf.js 6 routes THREE image filters through WebAssembly modules it fetches
// at run time: /JBIG2Decode and /CCITTFaxDecode both ride on `jbig2.wasm`
// (CCITTFaxStream delegates to JBig2CCITTFaxImage), /JPXDecode on
// `openjpeg.wasm`. `pdfRenderer.ts` used to set only `workerSrc` and
// nothing staged those modules into the build, so every one of those pages
// rendered BLANK — silently, with the failure logged inside the decoder and
// nothing surfaced to the user.
//
// The assertion is a coverage BAND, not "not blank". A stencil decoded with
// the wrong polarity renders 100% black, which passes any not-blank check
// while being just as wrong. The three fixtures are built from one synthetic
// pattern of known ink fraction (~0.184) by
// `fixtures/make-codec-fixtures.py`, which verifies its own output against
// the bundled Ghostscript before writing.
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  closeAllFiles,
  compressRun,
} from '../support/harness.js';

const FIXTURES = {
  '/CCITTFaxDecode (fax / scanner G4)': resolve(__dirname, '..', 'fixtures', 'codec-ccitt.pdf'),
  '/JBIG2Decode (scanned-document stencil)': resolve(__dirname, '..', 'fixtures', 'codec-jbig2.pdf'),
  '/JPXDecode (JPEG 2000)': resolve(__dirname, '..', 'fixtures', 'codec-jpx.pdf'),
} as const;

/** The pattern's own ink fraction, measured at generation time. */
const EXPECTED_INK = 0.184;
/** Antialiasing at the display raster plus JPEG2000's rate loss. */
const TOLERANCE = 0.09;

interface CanvasInk {
  canvases: number;
  /** Fraction of sampled pixels darker than mid-grey. */
  ink: number;
  /** Distinct-enough luminance buckets — 1 means a flat fill. */
  buckets: number;
}

async function readCanvasInk(): Promise<CanvasInk> {
  return browser.execute(function () {
    const list = Array.prototype.slice.call(
      document.querySelectorAll('canvas.pageview-base'),
    ) as HTMLCanvasElement[];
    const drawn = list.filter((c) => c.width > 8 && c.height > 8);
    if (drawn.length === 0) return { canvases: 0, ink: 0, buckets: 0 };
    const canvas = drawn[0];
    const ctx = canvas.getContext('2d');
    if (!ctx) return { canvases: drawn.length, ink: 0, buckets: 0 };
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    let total = 0;
    const seen: Record<number, boolean> = {};
    // Every 4th pixel: enough samples for a stable fraction, cheap enough to
    // run inside the webview without stalling the render loop.
    for (let i = 0; i < data.length; i += 16) {
      const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      if (lum < 128) dark += 1;
      seen[Math.floor(lum / 32)] = true;
      total += 1;
    }
    return { canvases: drawn.length, ink: total ? dark / total : 0, buckets: Object.keys(seen).length };
  });
}

describe('image codecs render', () => {
  before(async () => {
    await waitForHarness();
  });

  for (const [label, path] of Object.entries(FIXTURES)) {
    it(`draws a page whose image uses ${label}`, async () => {
      await closeAllFiles();
      await browser.execute(function () {
        (window as unknown as { __SPECTRA_TEST__: { clearRenderTimings(): void } }).__SPECTRA_TEST__.clearRenderTimings();
      });

      await openByPaths([path]);
      await setView('canvas');

      // Wait for pixels, not for a timing entry: pdf.js REPORTS a completed
      // render even when the image inside it decoded to nothing, which is
      // precisely the defect this spec exists for.
      let last: CanvasInk = { canvases: 0, ink: 0, buckets: 0 };
      await browser.waitUntil(
        async () => {
          last = await readCanvasInk();
          return last.canvases > 0 && last.buckets > 1;
        },
        {
          timeout: 30_000,
          timeoutMsg: `no page canvas carried any drawn content for ${label} — the decoder produced nothing`,
        },
      );

      console.log(`[codecs] ${label}: ink=${last.ink.toFixed(4)} buckets=${last.buckets}`);

      // Blank (module missing) is ink ~0; inverted polarity is ink ~0.82.
      expect(last.ink).toBeGreaterThan(EXPECTED_INK - TOLERANCE);
      expect(last.ink).toBeLessThan(EXPECTED_INK + TOLERANCE);
    });
  }

  after(async () => {
    await closeAllFiles();
  });
});

// The journey the is about: a user opens a scan,
// picks "Scanned document (MRC)" in the Compress panel, runs it, and gets a
// materially smaller file that STILL DRAWS in this app's own canvas.
//
// The last clause is the one that needs the staged wasm modules, and it is why this spec
// carries both halves: an MRC output whose stencil our viewer cannot decode
// would render blank here while looking perfect in another reader. The
// assertion is the same coverage BAND the codec fixtures use, for the same
// reason — an inverted stencil renders solid black and passes any not-blank
// check.
describe('MRC compression, end to end', () => {
  const SCAN = resolve(__dirname, '..', '..', 'tests', 'fixtures', 'scan-text.pdf');
  let tmp: string;

  before(async () => {
    await waitForHarness();
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-mrc-'));
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('compresses a scan through the panel and the result renders here', async function () {
    this.timeout(180_000);
    if (!existsSync(SCAN)) {
      // The fixture is generated by tests/fixtures/make_scans.py and checked
      // in; a tree without it has nothing to say about MRC.
      this.skip();
      return;
    }
    await closeAllFiles();
    await openByPaths([SCAN]);
    // `setActiveOp` seats the panel; it does NOT open the dock that mounts it
    // ('operations' is the name-compatible bridge that
    // focuses the doc tab and opens the right dock). Without this line the
    // panel never mounts and the harness answers "panel not mounted", which
    // is exactly what it did on the first battery run.
    await setView('operations');
    await setActiveOp('compress');

    const out = resolve(tmp, 'mrc.pdf');
    // The panel's REAL controls: the quality select's change handler puts it
    // on the MRC branch (which hides the DPI slider), then the real engine
    // call runs with the real Ghostscript and the vendored JBIG2 encoder.
    expect(await compressRun(out, { quality: 'mrc', mrcPreset: 'balanced' })).toBe('ok');
    expect(existsSync(out)).toBe(true);

    const before = statSync(SCAN).size;
    const after = statSync(out).size;
    console.log(`[mrc] ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`);
    // "Materially smaller" is the register's claim; the pytest suite pins the
    // exact bands against gs /ebook. Half is the loosest honest form of it.
    expect(after).toBeLessThan(before / 2);

    // …and it draws. Layers our own canvas cannot decode would be blank.
    await closeAllFiles();
    await browser.execute(function () {
      (window as unknown as { __SPECTRA_TEST__: { clearRenderTimings(): void } }).__SPECTRA_TEST__.clearRenderTimings();
    });
    await openByPaths([out]);
    await setView('canvas');

    let last: CanvasInk = { canvases: 0, ink: 0, buckets: 0 };
    await browser.waitUntil(
      async () => {
        last = await readCanvasInk();
        return last.canvases > 0 && last.buckets > 1;
      },
      {
        timeout: 60_000,
        timeoutMsg: 'the MRC output drew nothing on our own canvas',
      },
    );
    console.log(`[mrc] rendered ink=${last.ink.toFixed(4)} buckets=${last.buckets}`);
    // A page of body text: some ink, nowhere near solid, and never blank.
    expect(last.ink).toBeGreaterThan(0.005);
    expect(last.ink).toBeLessThan(0.5);
  });

  it('verifying the text keeps the page when the words survive', async function () {
    this.timeout(300_000);
    if (!existsSync(SCAN)) {
      this.skip();
      return;
    }
    await closeAllFiles();
    await openByPaths([SCAN]);
    await setView('operations');
    await setActiveOp('compress');
    const out = resolve(tmp, 'mrc-verified.pdf');
    // Slice E's switch, through the panel that offers it. On this fixture the
    // words DO survive, so the assertion is that the pass still ran — the
    // revert path itself is pinned deterministically in pytest, where the
    // score can be substituted instead of hoping a fixture fails.
    expect(
      await compressRun(out, { quality: 'mrc', mrcPreset: 'archival', verifyText: true }),
    ).toBe('ok');
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeLessThan(statSync(SCAN).size);
  });
});

// Issue #13's second half: the panel's optional second step. It is a SECOND
// operation on the file the first step wrote, not a compress parameter, so the
// proof is that the OUTPUT carries what only the optimize pass does —
// linearization — and that the panel says both halves happened.
describe('compress, then optimize', () => {
  const SOURCE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
  let tmp: string;

  before(async () => {
    await waitForHarness();
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-compress-steps-'));
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('runs both steps and the result is linearized', async function () {
    this.timeout(180_000);
    await closeAllFiles();
    await openByPaths([SOURCE]);
    await setView('operations');
    await setActiveOp('compress');

    // The Images summary is the DPI control's context, and it renders in this
    // panel from the same op the Properties dialog reads.
    await $('[data-testid="compress-image-resolution"]').waitForDisplayed({
      timeoutMsg: 'the Compress panel never showed an image summary',
    });

    const out = resolve(tmp, 'compressed-optimized.pdf');
    expect(await compressRun(out, { quality: 'ebook', thenOptimize: true })).toBe('ok');
    expect(existsSync(out)).toBe(true);
    // Both halves reported, in one line: the compression figures and the
    // optimize figures.
    const status = await $('[data-testid="status-bar"]').getText();
    expect(status).toContain('reduction');
    expect(status).toContain('Then optimized to');

    // Only the second step linearizes, so this is what tells a two-step run
    // from a compress that ignored the checkbox.
    await closeAllFiles();
    await openByPaths([out]);
    await browser.keys(['Control', 'd']);
    await $('[data-testid="properties-dialog"]').waitForDisplayed({
      timeoutMsg: 'Ctrl+D did not open Properties on the two-step output',
    });
    await $('[data-testid="props-tab-advanced"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="props-linearized"]').getText()) === 'Yes',
      { timeoutMsg: 'the two-step output was not linearized' },
    );
    await $('[data-testid="props-close"]').click();
    await closeAllFiles();
  });
});
