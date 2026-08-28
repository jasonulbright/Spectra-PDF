import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { waitForHarness, openByPaths, setView, setActiveOp } from '../support/harness.js';

async function makeTextPdf(path: string, lines: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  let y = 350;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 16, font });
    y -= 30;
  }
  writeFileSync(path, await doc.save());
}

describe('compare panel diffs two open PDFs', () => {
  let tmp: string;
  let a: string;
  let b: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-compare-'));
    a = resolve(tmp, 'a.pdf');
    b = resolve(tmp, 'b.pdf');
    await makeTextPdf(a, ['ALPHA', 'BETA', 'GAMMA']);
    await makeTextPdf(b, ['ALPHA', 'BETA', 'GAMMA', 'DELTA']); // one extra line
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('reports the differing line between two open files', async () => {
    await waitForHarness();
    await openByPaths([a, b]); // both open; the compare panel picks the other as target
    await setView('operations');
    await setActiveOp('compare');

    const target = $('[data-testid="compare-target"]');
    await target.waitForDisplayed({ timeout: 15_000 });
    await $('[data-testid="compare-run"]').click();

    const summary = $('[data-testid="compare-summary"]');
    await summary.waitForDisplayed({ timeout: 20_000 });
    // The two files genuinely differ, so it must not report "identical".
    expect(await summary.getText()).not.toContain('identical');

    const rows = $('[data-testid="compare-rows"]');
    await rows.waitForDisplayed({ timeout: 20_000 });
    expect(await rows.getText()).toContain('DELTA');

    // The SIGN, not merely the presence of the line. The panel passes the
    // TARGET as the engine's baseline and the ACTIVE document as the changed
    // side, so a line present only in the active document is an `add` and a
    // line present only in the target is a `remove`. Asserting only that
    // DELTA appears somewhere passes just as happily with the polarity
    // inverted, which is exactly the bug the wiring above was fixed for.
    // The expected sign is derived from which file the target select holds,
    // so the assertion does not depend on which of the two opened first.
    // Paths are canonicalized at the Rust boundary, so the select's value is
    // matched by basename rather than by the string this spec wrote.
    const targetIsA = (await target.getValue()).replace(/\\/g, '/').endsWith('/a.pdf');
    const expected = targetIsA ? 'add' : 'remove';
    const deltaRow = $(`[data-testid="compare-rows"] [data-diff-type="${expected}"]`);
    await deltaRow.waitForDisplayed({ timeout: 10_000 });
    expect(await deltaRow.getText()).toContain('DELTA');
    // And it is not ALSO reported with the opposite sign.
    const opposite = await $$(
      `[data-testid="compare-rows"] [data-diff-type="${expected === 'add' ? 'remove' : 'add'}"]`,
    );
    for (const el of opposite) {
      expect(await el.getText()).not.toContain('DELTA');
    }
  });

  it('visual mode pixel-diffs the pair and lists differing pages', async () => {
    // Same two files: the extra DELTA line is also a *visual* difference on
    // the page raster, so the visual pass must flag page pair 1. This drives
    // the real engine `compare_visual` (bundled Ghostscript raster) end to
    // end through the panel.
    await waitForHarness();
    await openByPaths([a, b]);
    await setView('operations');
    await setActiveOp('compare');

    const target = $('[data-testid="compare-target"]');
    await target.waitForDisplayed({ timeout: 15_000 });
    await $('[data-testid="compare-mode-visual"]').click();
    await $('[data-testid="compare-run"]').click();

    const summary = $('[data-testid="compare-visual-summary"]');
    await summary.waitForDisplayed({ timeout: 30_000 });
    expect(await summary.getText()).toContain('1 of 1 page pair differ');

    // The differing pair is listed and auto-selected; both page renders with
    // overlay hosts appear.
    const pairItem = $('[data-testid="compare-visual-pair-1"]');
    await pairItem.waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="compare-visual-page-A"]').waitForDisplayed({ timeout: 20_000 });
    await $('[data-testid="compare-visual-page-B"]').waitForDisplayed({ timeout: 20_000 });
  });
});
