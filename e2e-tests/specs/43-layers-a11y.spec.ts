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
    // The report runs on open. A plain PDF fails "tagged", and the row it
    // fails on carries its own verdict.
    const tagged = await $('[data-testid="a11y-check-tagged"]');
    await tagged.waitForDisplayed({ timeout: 20_000 });
    expect(await tagged.getAttribute('data-a11y-status')).toBe('fail');
    expect(await tagged.getText()).toContain('tagged');
    const summary = await $('[data-testid="a11y-summary"]').getText();
    expect(summary.toLowerCase()).toContain('failed');
    // The image-only check passes — the fixture has real text — and its row is
    // in the same category, so it renders beside the failure.
    const imageOnly = await $('[data-testid="a11y-check-image_only"]');
    expect(await imageOnly.isDisplayed()).toBe(true);
    expect(await imageOnly.getAttribute('data-a11y-status')).toBe('pass');
  });

  it('preflight flags a non-embedded standard font', async () => {
    // pdf-lib draws with a base-14 StandardFont, which is NOT embedded.
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('preflight');
    await $('[data-testid="preflight-check-fonts_embedded"]').waitForDisplayed({ timeout: 20_000 });
    const summary = await $('[data-testid="preflight-summary"]').getText();
    expect(summary.toLowerCase()).toContain('failed');
    expect(await $('[data-testid="preflight-check-fonts_embedded"]').getText()).toContain('embedded');
  });
});
