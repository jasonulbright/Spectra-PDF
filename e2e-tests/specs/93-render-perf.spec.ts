// N13 — the rendering-performance harness. The raster layer records every
// completed pdf.js render (base + detail); this spec drives a real document
// through the reading view and reports the distribution. Assertions are
// SANITY bounds only (timings exist; nothing pathological) — absolute
// thresholds flake across machines, so the BASELINE is the reported median,
// recorded in docs/PUNCHLIST.md's dev notes per milestone and compared by
// humans (or a future trend job), never by a hard CI gate.
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, setView, closeAllFiles } from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

interface Timing {
  kind: string;
  pageNumber: number;
  ms: number;
}

async function renderTimings(): Promise<Timing[]> {
  return browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.getRenderTimings();
  });
}

describe('render-performance harness (N13)', () => {
  it('records base-raster timings for a document read and reports the baseline', async () => {
    await waitForHarness();
    await closeAllFiles();
    await browser.execute(function () {
      (window as any).__SPECTRA_TEST__.clearRenderTimings();
    });

    await openByPaths([SAMPLE_PDF]);
    await setView('canvas');

    // NEAR pages render (IntersectionObserver-gated) — below-the-fold pages
    // deliberately don't, so the honest floor is "at least the visible
    // page(s)", not the fixture's full count (first-run catch: asserting 5
    // waited on rasters that are never supposed to happen).
    await browser.waitUntil(
      async () => (await renderTimings()).filter((t) => t.kind === 'base').length >= 1,
      { timeout: 30_000, timeoutMsg: 'no base raster completed' },
    );
    // Let the near-window finish rendering before sampling.
    await browser.pause(1500);

    const base = (await renderTimings()).filter((t) => t.kind === 'base');
    const sorted = base.map((t) => t.ms).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const max = sorted[sorted.length - 1];

    // The REPORT — this line is the harness's product; the number lands in
    // the punchlist dev notes as the current baseline.
    console.log(
      `[render-perf] base rasters: n=${base.length} median=${median.toFixed(1)}ms ` +
        `max=${max.toFixed(1)}ms (blank 5-page fixture, near pages only)`,
    );

    expect(base.length).toBeGreaterThanOrEqual(1);
    for (const t of base) {
      expect(t.ms).toBeGreaterThan(0);
      // Sanity only: a blank page taking >10s is a hang, not slowness.
      expect(t.ms).toBeLessThan(10_000);
    }

    await closeAllFiles();
  });
});
