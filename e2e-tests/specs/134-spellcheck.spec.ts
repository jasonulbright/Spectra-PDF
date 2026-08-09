/**
 * Spell check, end to end.
 *
 * The checker, the tokenizer and the dictionary set all have exact pytest
 * coverage. What this proves is the path a reader takes, and the one property
 * no unit test can: that the fix goes through the REAL paragraph-edit
 * machinery, so the corrected paragraph is re-typeset and every neighbouring
 * run on the page is left exactly where it was.
 *
 * Two halves, in the order a reader meets them:
 *   1. the paragraph editor draws the squiggle from this app's own checker;
 *   2. the Spelling panel lists the misspellings, and changing one corrects
 *      the page.
 */
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
  setActiveOp,
  saveActiveAs,
  invokeAppCommand,
  closeAllFiles,
  openParagraphEditor,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// The paragraph that gets fixed, and a NEIGHBOUR far enough down the page
// that the grouping cannot join them. The neighbour is the byte-stability
// witness: a rewrite that disturbs it is the failure this spec exists to
// catch.
const BAD = 'We recieve the report';
const NEIGHBOUR = 'This line must not move';

interface Item {
  str: string;
  transform: number[];
}

async function makeFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(BAD, { x: 72, y: 700, size: 12, font });
  page.drawText(NEIGHBOUR, { x: 72, y: 500, size: 12, font });
  writeFileSync(path, await doc.save());
}

async function textItems(path: string): Promise<Item[]> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  await pdf.loadingTask.destroy();
  return (content.items as Array<{ str: string; transform: number[] }>)
    .filter((i) => i.str.trim().length > 0)
    .map((i) => ({ str: i.str, transform: i.transform.map((v) => Math.round(v * 100) / 100) }));
}

describe('spell check', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-p32-'));
    source = resolve(tmp, 'src.pdf');
    await makeFixture(source);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('underlines a misspelling in the paragraph editor', async () => {
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    const pageIds = (await browser.execute(function () {
      return (window as unknown as { __SPECTRA_TEST__: { editTextPageIds(): string[] } })
        .__SPECTRA_TEST__.editTextPageIds();
    })) as string[];
    expect(pageIds.length).toBeGreaterThan(0);
    await openParagraphEditor(pageIds[0], 0);

    // The check is debounced and is an engine round trip, so the mark arrives
    // a beat after the editor does. The CLASS is what is asserted, not a
    // colour: the squiggle is painted by a stylesheet rule.
    await browser.waitUntil(
      async () => (await $$('.page-editpara-misspelled')).length > 0,
      { timeout: 30_000, timeoutMsg: 'the editor never marked the misspelling' },
    );
    const marked = await $('.page-editpara-misspelled').getText();
    expect(marked).toBe('recieve');

    // Leave the editor without changing anything — the panel does the fixing.
    await browser.keys(['Escape']);
  });

  it('lists the misspellings and corrects one through the editor machinery', async () => {
    const before = await textItems(source);

    expect(await invokeAppCommand('tools.panel.spelling')).toBe(true);
    await setActiveOp('spelling');
    await $('[data-testid="spelling-check"]').waitForExist({ timeout: 15_000 });
    await $('[data-testid="spelling-check"]').click();

    await browser.waitUntil(async () => await $('[data-testid="spelling-report"]').isExisting(), {
      timeout: 60_000,
      timeoutMsg: 'the check never reported',
    });
    // Exactly one misspelling: "recieve". Every other word of both lines is
    // ordinary English, so a second hit would mean the tokenizer is offering
    // something it should not.
    expect(await $('[data-testid="spelling-count"]').getText()).toContain('1');
    await $('[data-testid="spelling-word-recieve"]').waitForExist({ timeout: 15_000 });
    await $('[data-testid="spelling-word-recieve"]').click();

    // The dictionary's own first suggestion is the intended word — pinned in
    // pytest too, asserted here because it is what the reader clicks.
    await $('[data-testid="spelling-suggestion-receive"]').waitForExist({ timeout: 30_000 });
    await $('[data-testid="spelling-suggestion-receive"]').click();
    await $('[data-testid="spelling-change"]').click();

    await browser.waitUntil(
      async () => !(await $('[data-testid="spelling-word-recieve"]').isExisting()),
      { timeout: 60_000, timeoutMsg: 'the change never landed' },
    );

    const dest = resolve(tmp, 'fixed.pdf');
    await saveActiveAs(dest);
    const after = await textItems(dest);

    const joined = after.map((i) => i.str).join(' ');
    expect(joined).toContain('receive');
    expect(joined).not.toContain('recieve');

    // THE NEIGHBOUR IS BYTE-STABLE. Every run of the untouched line must come
    // back with the same text at the same composed matrix — a re-typeset that
    // moved it would be the regression this pins.
    const neighbourBefore = before.filter((i) => NEIGHBOUR.includes(i.str.trim()));
    const neighbourAfter = after.filter((i) => NEIGHBOUR.includes(i.str.trim()));
    expect(neighbourBefore.length).toBeGreaterThan(0);
    expect(neighbourAfter).toEqual(neighbourBefore);
  });
});
