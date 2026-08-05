// The opaque fallback IS the designed presentation wherever DWM
// composes no backdrop (transparency effects off, remote sessions, builds
// below 22000). The rest of the battery only ever exercises backdrop-ON,
// because a dev box composes Mica; this session launches with
// SPECTRAPDF_E2E_FORCE_OPAQUE=1 (set per-spec in wdio.conf.ts, honoured by
// an e2e-gated lever in lib.rs) so the fallback runs LIVE: no data-backdrop
// attribute, opaque shell surfaces, and a document reaching the canvas —
// the fallback is a complete app, not just a look.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  getState,
  closeAllFiles,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

describe('backdrop fallback presentation', () => {
  it('renders the solid shell: no data-backdrop, opaque surfaces, working app', async () => {
    await waitForHarness();

    // The fallback contract is NO attribute (backdrop.ts: anything but a
    // positive "mica" leaves the CSS delta at zero).
    const attr = await browser.execute(() =>
      document.documentElement.getAttribute('data-backdrop'),
    );
    expect(attr).toBe(null);

    // Alpha of a computed backgroundColor, across serializations: legacy
    // rgb()/rgba() and the modern space/slash forms Tailwind 4's oklch
    // colors produce ("oklch(0.145 0 0)", "oklch(... / 0.6)").
    const alphaOf = (bg: string): number => {
      if (!bg || bg === 'transparent') return 0;
      const rgba = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(bg);
      if (rgba) return Number(rgba[1]);
      const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(bg);
      if (slash) return slash[2] ? Number(slash[1]) / 100 : Number(slash[1]);
      return 1;
    };

    // No TRANSLUCENT chrome: the mica rules paint the shell layers at
    // fractional alpha over the composed backdrop; without a backdrop each
    // layer is either fully opaque or unpainted at that level (alpha 0 —
    // the opaque paint lives below it in an opaque window). A fractional
    // alpha here is styling for a material DWM never composed.
    const backgrounds = await browser.execute(() =>
      ['.app-shell', '.app-shell-bar'].map((sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : 'missing';
      }),
    );
    for (const bg of backgrounds) {
      expect(bg).not.toBe('missing');
      const a = alphaOf(bg);
      expect(a === 0 || a === 1).toBe(true);
    }

    // And the shell's base coat is genuinely opaque — .app-shell carries the
    // app's own solid background (bg-neutral-900); in the fallback that IS
    // the window's paint, with no backdrop behind it to leak through.
    expect(alphaOf(backgrounds[0])).toBe(1);

    // And it is an APP in this presentation, not a rendering: a document
    // opens and reaches the canvas.
    await closeAllFiles();
    const tmp = mkdtempSync(join(tmpdir(), 'spectra-fallback-'));
    const work = join(tmp, 'doc.pdf');
    copyFileSync(SAMPLE_PDF, work);
    await openByPaths([work]);
    await setView('canvas');
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('doc.pdf'),
      { timeout: 15_000, timeoutMsg: 'document never became active in fallback mode' },
    );
  });
});
