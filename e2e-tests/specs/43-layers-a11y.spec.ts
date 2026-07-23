import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { waitForHarness, openByPaths, setView, setActiveOp } from '../support/harness.js';

async function makeTextPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText('Readable text', { x: 40, y: 200, size: 14, font });
  writeFileSync(path, await doc.save());
}

describe('layers + accessibility panels', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-la-'));
    source = resolve(tmp, 'plain.pdf');
    await makeTextPdf(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('layers panel shows the empty state for a document with no layers', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('layers');
    await $('[data-testid="layers-empty"]').waitForDisplayed({ timeout: 20_000 });
  });

  it('accessibility checker reports failing checks for a plain PDF', async () => {
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('accessibility');
    // The checklist runs on open; a plain PDF fails "tagged" and passes "text".
    await $('[data-testid="a11y-check-tagged"]').waitForDisplayed({ timeout: 20_000 });
    const tagged = await $('[data-testid="a11y-check-tagged"]').getText();
    expect(tagged).toContain('tagged');
    const summary = await $('[data-testid="a11y-summary"]').getText();
    expect(summary.toLowerCase()).toContain('failed');
    // The extractable-text check passes (the fixture has real text).
    expect(await $('[data-testid="a11y-check-text"]').isDisplayed()).toBe(true);
  });
});
