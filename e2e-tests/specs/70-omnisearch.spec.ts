import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  setView,
  invokeAppCommand,
  getState,
} from '../support/harness.js';

// The universal search box in the toolbar row: ONE box that
// answers with both the TOOLS you can run and the TEXT in your documents.
//
// Driven through the real DOM because that pairing is the whole feature: the
// ranking is unit-tested (tests/omnisearch-rank.test.ts), but "typing a tool
// name launches the tool" and "typing a phrase lands on the page" only exist
// once the box, the command registry, and the search index are wired together.
//
// The fixture is built here rather than reused: the shared sample.pdf has NO
// extractable text, so it could never exercise the text half.

async function typeQuery(text: string): Promise<void> {
  await $('[data-testid="omnisearch-input"]').click();
  await browser.keys(text.split(''));
}

async function clearQuery(): Promise<void> {
  // Escape clears the text first (a second Escape would close the box).
  await $('[data-testid="omnisearch-input"]').click();
  await browser.keys(['Escape']);
}

describe('omnisearch', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'opds-omni-'));
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // TALL pages deliberately: two short pages both fit on screen at once, so
    // the current-page readout would never change and the jump assertion below
    // could not tell a working jump from a no-op.
    const p1 = doc.addPage([500, 900]);
    p1.drawText('The QUARTERLY revenue summary', { x: 40, y: 700, size: 15, font });
    const p2 = doc.addPage([500, 900]);
    p2.drawText('Appendix: quarterly notes and totals', { x: 40, y: 700, size: 15, font });
    const fixture = resolve(tmp, 'omni-fixture.pdf');
    writeFileSync(fixture, await doc.save());

    await waitForHarness();
    await closeAllFiles(); // isolate the index — only this file's text may match
    await openByPaths([fixture]);
    await setView('canvas');
    await invokeAppCommand('view.documentView');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lives in the toolbar row and stays closed until asked', async () => {
    await expect($('[data-testid="omnisearch-input"]')).toBeDisplayed();
    // Chrome, not a panel: nothing hangs open over the document unprompted.
    await expect($('[data-testid="omnisearch-results"]')).not.toBeExisting();
  });

  it('a tool name finds the TOOL and launching it opens that tool', async () => {
    await typeQuery('redact');
    await $('[data-testid="omnisearch-tool-redact"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'typing a tool name did not offer the tool',
    });
    await $('[data-testid="omnisearch-tool-redact"]').click();

    // It routes through the COMMAND, so the app really is in that tool.
    await browser.waitUntil(async () => (await getState()).tool === 'redact', {
      timeout: 10_000,
      timeoutMsg: 'the omnisearch tool result did not arm the tool',
    });
    // Running a result clears the box and dismisses the list.
    await expect($('[data-testid="omnisearch-results"]')).not.toBeExisting();
    expect(await $('[data-testid="omnisearch-input"]').getValue()).toBe('');
  });

  it('a phrase finds DOCUMENT TEXT, per page, with a snippet', async () => {
    await typeQuery('quarterly');
    await browser.waitUntil(
      async () => (await $$('[data-testid^="omnisearch-text-"]')).length >= 2,
      { timeout: 15_000, timeoutMsg: 'a term present on both pages did not produce two hits' },
    );
    const rows = await $$('[data-testid^="omnisearch-text-"]');
    const first = await rows[0].getText();
    // Page number AND context — a bare page list would not be a search result.
    expect(first).toContain('p.1');
    expect(first.toLowerCase()).toContain('quarterly');
    // Case-insensitive by default: the query is lowercase, the page shouts it.
    expect(first).toContain('QUARTERLY');
    await clearQuery();
  });

  it('a hit jumps the reading view to that page', async () => {
    await typeQuery('appendix'); // page 2 only
    await $('[data-testid^="omnisearch-text-"]').waitForDisplayed({ timeout: 15_000 });
    await $('[data-testid^="omnisearch-text-"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="page-nav-box"]').getValue()) === '2',
      { timeout: 15_000, timeoutMsg: 'clicking a text hit did not move the reading view to its page' },
    );
  });

  it('says so plainly when nothing matches', async () => {
    await typeQuery('zzzznotathing');
    await $('[data-testid="omnisearch-empty"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'a no-match query showed no empty state',
    });
    await clearQuery();
  });

  it('keyboard alone can run a result', async () => {
    await typeQuery('optimize');
    await $('[data-testid="omnisearch-tool-optimize"]').waitForDisplayed({ timeout: 10_000 });
    await browser.keys(['ArrowDown']); // move off the first row and back
    await browser.keys(['ArrowUp']);
    await browser.keys(['Enter']);
    await browser.waitUntil(
      async () => (await $('[data-testid="tool-dock-title"]').isExisting())
        && (await $('[data-testid="tool-dock-title"]').getText()) === 'Optimize',
      { timeout: 10_000, timeoutMsg: 'Enter on a highlighted tool result did not open it' },
    );
  });
});
