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

    // The extra line shows up in the diff (as an add or remove depending on
    // which file is active — either way DELTA is the change).
    const rows = $('[data-testid="compare-rows"]');
    await rows.waitForDisplayed({ timeout: 20_000 });
    expect(await rows.getText()).toContain('DELTA');
  });
});
