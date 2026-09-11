import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { answerNextSaveDialog, closeAllFiles, commitPendingEdits, getState, invokeAppCommand,
  openByPaths, selectCanvasPages, setActiveOp, setView, waitForActiveCanvasPageIds,
  waitForHarness } from '../support/harness.js';

function fixture(catalog: string): Buffer {
  const objects = [`<< /Type /Catalog /Pages 2 0 R /Version /${catalog} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 700] /Resources <<>> >>'];
  let data = '%PDF-1.3\n'; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += 'xref\n0 4\n0000000000 65535 f \n';
  for (const offset of offsets) data += `${String(offset).padStart(10, '0')} 00000 n \n`;
  data += `trailer\n<< /Root 1 0 R /Size 4 >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(data);
}
async function openVersion(catalog: string, unreadable = false) {
  const dir = mkdtempSync(resolve(__dirname, '../../version-facts.local.d-'));
  const source = resolve(dir, 'source.pdf'), output = resolve(dir, 'output.pdf'), bytes = fixture(catalog);
  writeFileSync(source, bytes); await closeAllFiles(); await openByPaths([source]);
  const ids = await waitForActiveCanvasPageIds();
  await setView('operations'); await setActiveOp('pdf_version');
  await $('select[aria-label="PDF version"]').waitForDisplayed();
  await browser.waitUntil(async () => (await $('body').getText()).includes(unreadable
    ? 'The PDF version cannot be determined.' : `Current version: PDF ${catalog}`),
    { timeout: 15000, timeoutMsg: 'The panel did not read the effective catalog declaration' });
  return { source, output, bytes, ids };
}

describe('PDF version declarations at the live engine and panel boundaries', () => {
  before(async () => { await waitForHarness(); });
  it('does not replace an unreadable catalog fact with a plausible header', async () => {
    const { source, bytes } = await openVersion('2.1', true);
    expect(await $('body').getText()).not.toContain('Current version: PDF');
    expect(readFileSync(source).equals(bytes)).toBe(true);
  });
  it('shows the effective version and refuses a lower label without changing files', async () => {
    const { source, output, bytes } = await openVersion('2.0');
    writeFileSync(output, 'keep existing destination');
    await answerNextSaveDialog(output); await $('button=Set Version').click();
    await browser.waitUntil(async () => (await $('body').getText()).includes('cannot be lowered'), { timeout: 15000 });
    expect(readFileSync(output, 'utf8')).toBe('keep existing destination');
    expect(readFileSync(source).equals(bytes)).toBe(true);
  });
  it('raises a requirement and publishes matching declarations', async () => {
    const { source, output, bytes } = await openVersion('1.4');
    await answerNextSaveDialog(output); await $('button=Set Version').click();
    await browser.waitUntil(async () => (await $('body').getText()).includes('PDF 1.4 → PDF 1.7'), { timeout: 15000 });
    const written = await PDFDocument.load(readFileSync(output), { updateMetadata: false });
    expect(written.catalog.get(PDFName.of('Version'))?.toString()).toBe('/1.7');
    expect(readFileSync(source).equals(bytes)).toBe(true);
  });
  it('refreshes the declaration after a same-path page-tier publication', async () => {
    const { ids } = await openVersion('1.4');
    const working = (await getState()).activeFile!.workingPath;
    await selectCanvasPages([ids[0]]);
    expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    await commitPendingEdits();
    expect((await getState()).activeFile!.workingPath).toBe(working);
    expect(readFileSync(working).subarray(0, 8).toString()).toBe('%PDF-1.7');
    await browser.waitUntil(async () => (await $('body').getText()).includes('Current version: PDF 1.7'),
      { timeout: 15000, timeoutMsg: 'The version fact stayed stale after buffer publication' });
  });
});
