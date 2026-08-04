// O8 slice A — the viewer decodes the filters scanners and fax gateways write.
//
// pdf.js 6 routes THREE image filters through WebAssembly modules it fetches
// at run time: /JBIG2Decode and /CCITTFaxDecode both ride on `jbig2.wasm`
// (CCITTFaxStream delegates to JBig2CCITTFaxImage), /JPXDecode on
// `openjpeg.wasm`. Until slice A, `pdfRenderer.ts` set only `workerSrc` and
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
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, setView, closeAllFiles } from '../support/harness.js';

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

describe('image codecs render (O8 slice A)', () => {
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
