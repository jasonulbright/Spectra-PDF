import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  saveActiveAs,
  addRedactionMark,
  applyRedactions,
  clearRedactionMarks,
  getRedactionMarkCount,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// The checked-in sample.pdf has empty content streams, so this suite builds
// its own fixture: page 1 carries text near the top (inside the redacted
// band) and near the bottom (outside it); page 2 carries text that proves
// page targeting doesn't leak.
async function makeTextFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([612, 792]);
  page1.drawText('SECRET TOP LINE', { x: 50, y: 700, size: 24, font });
  page1.drawText('KEEP ME BOTTOM', { x: 50, y: 100, size: 24, font });
  const page2 = doc.addPage([612, 792]);
  page2.drawText('PAGE TWO SURVIVES', { x: 50, y: 400, size: 24, font });
  writeFileSync(path, await doc.save());
}

async function pageTexts(path: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = (await page.getTextContent()) as { items: { str?: string }[] };
    texts.push(content.items.map((it) => it.str ?? '').join(' '));
  }
  await pdf.loadingTask.destroy();
  return texts;
}

describe('redaction strips content through the real engine round trip', () => {
  let tmp: string;
  let source: string;
  let dest: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-redact-'));
    source = resolve(tmp, 'redact-me.pdf');
    dest = resolve(tmp, 'redacted.pdf');
    await makeTextFixture(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('marks can be added and cleared before anything is applied', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('canvas');

    const { markId, pageId } = await addRedactionMark({ x: 0.1, y: 0.6, w: 0.2, h: 0.1 });
    expect(markId).toBeTruthy();
    expect(pageId).toBeTruthy();
    expect(await getRedactionMarkCount()).toBe(1);

    await clearRedactionMarks();
    expect(await getRedactionMarkCount()).toBe(0);
  });

  it('a marked region removes its text from the saved file and spares everything else', async () => {
    // Top quarter of page 1 in display space — covers the y=700 text line,
    // stays well clear of the y=100 one.
    await addRedactionMark({ x: 0, y: 0, w: 1, h: 0.25 });
    expect(await getRedactionMarkCount()).toBe(1);

    await applyRedactions();
    expect(await getRedactionMarkCount()).toBe(0); // applied marks are consumed

    await saveActiveAs(dest);
    expect(existsSync(dest)).toBe(true);

    const texts = await pageTexts(dest);
    expect(texts).toHaveLength(2);
    expect(texts[0]).not.toContain('SECRET TOP LINE');
    expect(texts[0]).toContain('KEEP ME BOTTOM');
    expect(texts[1]).toContain('PAGE TWO SURVIVES');
  });
});
