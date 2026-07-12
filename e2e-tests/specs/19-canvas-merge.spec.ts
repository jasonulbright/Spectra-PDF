import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  saveActiveAs,
  closeAllFiles,
  commitPendingEdits,
  pressGlobalKey,
  getCanvasDocs,
  mergeDocUp,
  removeCanvasDoc,
  mergeNoticeText,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// Target: 2 plain pages. Source: 1 page carrying a FILLED form field — the
// merge must carry it into the combined file (2n.4a's multi-source AcroForm
// carry, proven here in the real user flow).
async function makeTarget(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([600, 400]);
  p1.drawText('target page one', { x: 40, y: 200 });
  const p2 = doc.addPage([600, 400]);
  p2.drawText('target page two', { x: 40, y: 200 });
  writeFileSync(path, await doc.save());
}

async function makeFormSource(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const field = doc.getForm().createTextField('carried_along');
  field.setText('merged with me');
  field.addToPage(page, { x: 50, y: 300, width: 250, height: 22 });
  writeFileSync(path, await doc.save());
}

describe('canvas whole-document merge (2o)', () => {
  let tmp: string;
  let target: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-merge-'));
    target = resolve(tmp, 'target.pdf');
    source = resolve(tmp, 'source.pdf');
    await makeTarget(target);
    await makeFormSource(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('merge-up copies the pages, guards the source, and bakes one combined file', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([target, source]);
    await setView('canvas');

    let docs = await getCanvasDocs();
    expect(docs).toHaveLength(2);
    const targetDoc = docs.find((d) => d.path === target)!;
    const sourceDoc = docs.find((d) => d.path === source)!;
    expect(targetDoc.pages).toBe(2);
    expect(sourceDoc.pages).toBe(1);

    await mergeDocUp(sourceDoc.id);
    docs = await getCanvasDocs();
    expect(docs.find((d) => d.id === targetDoc.id)!.pages).toBe(3); // grew
    expect(docs.find((d) => d.id === sourceDoc.id)!.pages).toBe(1); // copy, not move

    // Pre-commit, the source file's bytes back the staged copies — the
    // guarded remove must refuse and explain.
    await removeCanvasDoc(sourceDoc.id);
    expect(await mergeNoticeText()).toContain('Apply changes first');
    expect((await getCanvasDocs())).toHaveLength(2); // nothing closed

    await commitPendingEdits();

    // Post-commit the copies are baked into the target; closing the source
    // is ordinary now.
    await removeCanvasDoc(sourceDoc.id);
    await browser.waitUntil(async () => (await getCanvasDocs()).length === 1, {
      timeout: 10_000,
      timeoutMsg: 'source doc never closed after commit',
    });

    const dest = resolve(tmp, 'combined.pdf');
    await saveActiveAs(dest);

    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(dest)),
      isEvalSupported: false,
    }).promise;
    expect(pdf.numPages).toBe(3);
    // Page order: target's two pages, then the merged page with the field.
    const p1text = (await (await pdf.getPage(1)).getTextContent()) as { items: { str?: string }[] };
    expect(p1text.items.map((i) => i.str ?? '').join(' ')).toContain('target page one');
    const annots = (await (await pdf.getPage(3)).getAnnotations()) as {
      fieldName?: string;
      fieldValue?: unknown;
    }[];
    const field = annots.find((a) => a.fieldName === 'carried_along');
    expect(field).toBeDefined();
    expect(field!.fieldValue).toBe('merged with me'); // 2n.4a in the user flow
    await pdf.loadingTask.destroy();
  });

  it('a staged merge undoes as ONE step', async () => {
    // Re-open fresh (previous test closed the source).
    await closeAllFiles();
    await openByPaths([target, source]);
    await setView('canvas');
    let docs = await getCanvasDocs();
    const sourceDoc = docs.find((d) => d.path === source)!;
    const targetDoc = docs.find((d) => d.path === target)!;
    const before = targetDoc.pages;

    await mergeDocUp(sourceDoc.id);
    expect((await getCanvasDocs()).find((d) => d.id === targetDoc.id)!.pages).toBe(before + 1);

    await pressGlobalKey('z', { ctrl: true });
    await browser.waitUntil(
      async () => (await getCanvasDocs()).find((d) => d.id === targetDoc.id)!.pages === before,
      { timeout: 10_000, timeoutMsg: 'merge did not undo in one step' },
    );
    // The staged copies are gone with that single step — the close-guard no
    // longer trips and the source closes normally.
    await removeCanvasDoc(sourceDoc.id);
    await browser.waitUntil(async () => (await getCanvasDocs()).length === 1, {
      timeout: 10_000,
      timeoutMsg: 'source doc did not close after the merge was undone',
    });
  });
});
