// Search & Redact: one search marks every occurrence across every open
// document, and the CHECKBOX is what decides which ones go.
//
// 25-search covers find and its modes; 92-redaction-marks covers the /Redact
// persistence. Neither joins them, and the join is the whole feature: the
// last assertion here — an UNCHECKED occurrence of the very same term
// SURVIVING in the same file — is the one that proves the checkbox means
// something rather than being decoration over a whole-document sweep.
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
  invokeAppCommand,
  saveActiveAs,
  focusTab,
  closeAllFiles,
  getState,
  getRedactionMarkCount,
  clearRedactionMarks,
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const TERM = 'Jane Roe';

/** Two documents, the term on three pages across them — and neighbouring
 * words on every one of those pages, so "the redaction took the line" is
 * distinguishable from "the redaction took the words". */
async function makeFixture(a: string, b: string): Promise<void> {
  const docA = await PDFDocument.create();
  const fontA = await docA.embedFont(StandardFonts.Helvetica);
  const a1 = docA.addPage([612, 792]);
  a1.drawText(`CONFIDENTIAL ${TERM} report`, { x: 50, y: 700, size: 18, font: fontA });
  const a2 = docA.addPage([612, 792]);
  a2.drawText(`Second mention of ${TERM} here`, { x: 50, y: 700, size: 18, font: fontA });
  writeFileSync(a, await docA.save());

  const docB = await PDFDocument.create();
  const fontB = await docB.embedFont(StandardFonts.Helvetica);
  const b1 = docB.addPage([612, 792]);
  b1.drawText(`Contact ${TERM} at once`, { x: 50, y: 700, size: 18, font: fontB });
  writeFileSync(b, await docB.save());
}

async function pageTexts(path: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
  }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = (await page.getTextContent()) as { items: { str?: string }[] };
    texts.push(content.items.map((it) => it.str ?? '').join(''));
  }
  await pdf.loadingTask.destroy();
  return texts;
}

/** Hit rows are keyed by file name, page and the engine's hit index. */
function hitSelector(file: string, page: number, index: number): string {
  return `[data-testid="search-redact-hit-${file}-${page}-${index}"]`;
}

/** Click through the DOM rather than the pointer.
 *
 * The result list is a scroller inside the dock, so a row below the fold is
 * present, displayed and still not "interactable" to WebDriver — the same
 * class of problem the canvas gestures hit, and the same answer: drive the
 * element, not the pixels. A DOM `click()` on a checkbox or a button fires
 * React's handler exactly as a real click does. */
async function clickEl(selector: string): Promise<void> {
  const el = await $(selector);
  await el.waitForExist({ timeout: 20_000 });
  await browser.execute((s: string) => {
    const node = document.querySelector(s) as HTMLElement | null;
    node?.scrollIntoView({ block: 'center' });
    node?.click();
  }, selector);
}

describe('Search & Redact', () => {
  let tmp: string;
  let fileA: string;
  let fileB: string;
  let outA: string;
  let outB: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-f15-'));
    fileA = resolve(tmp, 'alpha.pdf');
    fileB = resolve(tmp, 'beta.pdf');
    outA = resolve(tmp, 'alpha-out.pdf');
    outB = resolve(tmp, 'beta-out.pdf');
    await makeFixture(fileA, fileB);
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('searches every open document, marks only the checked hits, and applies them', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([fileA, fileB]);
    await setView('canvas');
    await focusTab({ doc: fileA });

    // One command seats the panel in the dock AND arms the redact mode — the
    // op's owning tool opens with it (the `ui.tool` rule).
    expect(await invokeAppCommand('tools.panel.search_redact')).toBe(true);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="search-redact-panel"]').waitForDisplayed({ timeout: 10_000 });

    await setReactSelectValue('[data-testid="search-redact-scope"]', 'all');
    await setReactInputValue('[data-testid="search-redact-query"]', TERM);
    await clickEl('[data-testid="search-redact-run"]');

    // Three occurrences: two in alpha (pages 1 and 2), one in beta.
    const hitA1 = hitSelector('alpha.pdf', 1, 0);
    const hitA2 = hitSelector('alpha.pdf', 2, 1);
    const hitB1 = hitSelector('beta.pdf', 1, 0);
    await $(hitA1).waitForDisplayed({ timeout: 30_000 });
    await $(hitA2).waitForDisplayed({ timeout: 10_000 });
    await $(hitB1).waitForDisplayed({ timeout: 10_000 });

    // Nothing is checked by default — a destructive tool does not pre-consent.
    expect(await $(hitA1).isSelected()).toBe(false);
    expect(await $(hitA2).isSelected()).toBe(false);
    expect(await $(hitB1).isSelected()).toBe(false);

    // Review: clicking a hit ROW jumps the canvas to its page. The alpha
    // page-2 row is on a page the reading view is not showing.
    const before = (await getState()).currentPageId;
    await clickEl(`${hitA2} + button`);
    await browser.waitUntil(
      async () => (await getState()).currentPageId !== before,
      { timeout: 15_000, timeoutMsg: 'clicking a hit did not move the camera' },
    );

    // Check a SUBSET across both documents: alpha page 1 and beta page 1,
    // deliberately leaving alpha page 2 alone.
    await clickEl(hitA1);
    await clickEl(hitB1);
    expect(await $(hitA2).isSelected()).toBe(false);

    await clickEl('[data-testid="search-redact-mark"]');
    await browser.waitUntil(async () => (await getRedactionMarkCount()) === 2, {
      timeout: 15_000,
      timeoutMsg: `expected 2 marks, saw ${await getRedactionMarkCount()}`,
    });

    // Apply through the SHIPPED path — the status bar's button and its
    // confirmation, exactly as a hand-drawn band applies. The panel never
    // calls redact itself.
    await clickEl('[data-testid="redact-apply-btn"]');
    await $('[data-testid="redact-confirm-btn"]').waitForDisplayed({ timeout: 10_000 });
    await clickEl('[data-testid="redact-confirm-btn"]');
    await browser.waitUntil(async () => (await getRedactionMarkCount()) === 0, {
      timeout: 60_000,
      timeoutMsg: 'applied marks were not consumed',
    });

    await focusTab({ doc: fileA });
    await saveActiveAs(outA);
    await focusTab({ doc: fileB });
    await saveActiveAs(outB);
    expect(existsSync(outA)).toBe(true);
    expect(existsSync(outB)).toBe(true);

    const textsA = await pageTexts(outA);
    const textsB = await pageTexts(outB);

    // The checked occurrences are GONE…
    expect(textsA[0]).not.toContain(TERM);
    expect(textsB[0]).not.toContain(TERM);
    // …their neighbours on the same line SURVIVED, which is what proves the
    // removal was per-glyph and not "drop the whole show operator".
    expect(textsA[0]).toContain('CONFIDENTIAL');
    expect(textsA[0]).toContain('report');
    expect(textsB[0]).toContain('Contact');
    expect(textsB[0]).toContain('at once');
    // …and the UNCHECKED occurrence is still there. This is the assertion
    // that proves the checkbox means something.
    expect(textsA[1]).toContain(TERM);
  });

  it('a built-in pattern finds what a plain search would not, and validates it', async () => {
    await closeAllFiles();
    const patternFile = resolve(tmp, 'pattern.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    // One real card number (passes Luhn) and one 16-digit reference that does
    // not — a pattern that offered both would teach the user to ignore it.
    page.drawText('card 4111111111111111 ref 1234567890123456', {
      x: 40,
      y: 700,
      size: 14,
      font,
    });
    writeFileSync(patternFile, await doc.save());

    await openByPaths([patternFile]);
    await setView('canvas');
    await setActiveOp('search_redact');
    await $('[data-testid="search-redact-panel"]').waitForDisplayed({ timeout: 10_000 });

    await clickEl('[data-testid="search-redact-pattern-credit_card"]');
    await clickEl('[data-testid="search-redact-run"]');

    const hit = hitSelector('pattern.pdf', 1, 0);
    await $(hit).waitForDisplayed({ timeout: 30_000 });
    // Exactly ONE hit: the Luhn-valid card. The other 16-digit run is not a
    // card and is not offered.
    expect((await $$(hitSelector('pattern.pdf', 1, 1))).length).toBe(0);

    await clickEl(hit);
    await clickEl('[data-testid="search-redact-mark"]');
    await browser.waitUntil(async () => (await getRedactionMarkCount()) === 1, {
      timeout: 15_000,
      timeoutMsg: 'the pattern hit did not become a mark',
    });

    // Re-running the search now shows that hit as ALREADY MARKED — its
    // checkbox is disabled, because ticking a box that cannot become a mark
    // is a control that does nothing.
    await clickEl('[data-testid="search-redact-run"]');
    await browser.waitUntil(async () => !(await $(hit).isEnabled()), {
      timeout: 20_000,
      timeoutMsg: 'an already-marked hit was still offered',
    });

    await clearRedactionMarks();
    await closeAllFiles();
  });
});
