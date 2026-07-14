import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  closeAllFiles,
  setView,
  setReactInputValue,
} from '../support/harness.js';

// Phase 4 M3.3: the Search nav panel — a result-list view over the shared
// workspace search index (same index the canvas FindBar uses). Drives the real
// DOM: open the panel, type a query, read the per-file hit list, and click a
// hit to confirm it routes through the find/highlight path (find.openWith).

async function ensureSearchOpen(): Promise<void> {
  const pressed = await $('[data-testid="navicon-search"]').getAttribute('aria-pressed');
  if (pressed !== 'true') await $('[data-testid="navicon-search"]').click();
  await $('[data-testid="search-panel"]').waitForDisplayed({ timeoutMsg: 'search panel did not open' });
}

describe('navigation pane — Search panel', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-search-'));
    // Two-page born-digital fixture: page 1 carries the query term, page 2
    // doesn't — so a hit must land on page 1 only.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([400, 300]);
    p1.drawText('The QUARTERLY revenue summary', { x: 40, y: 200, size: 14, font });
    const p2 = doc.addPage([400, 300]);
    p2.drawText('Unrelated appendix material', { x: 40, y: 200, size: 14, font });
    const fixture = resolve(tmp, 'searchable-digital.pdf');
    writeFileSync(fixture, await doc.save());

    await waitForHarness();
    await closeAllFiles(); // isolate the index — only this file's text should match
    await openByPaths([fixture]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening did not focus the doc tab',
    });
    await setView('canvas');
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lists a per-file hit with a page and a context snippet', async () => {
    await ensureSearchOpen();
    await setReactInputValue('[data-testid="search-input"]', 'revenue');
    await $('[data-testid="search-hit"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'search never surfaced a hit',
    });
    const hits = await $$('[data-testid="search-hit"]');
    expect(hits.length).toBe(1); // only page 1 matches
    const hitText = await $('[data-testid="search-hit"]').getText();
    expect(hitText).toContain('Page 1');
    expect(hitText.toLowerCase()).toContain('revenue'); // the snippet
    const fileName = await $('[data-testid="search-file-name"]').getText();
    expect(fileName).toContain('searchable-digital');
  });

  it('clicking a hit opens the find highlight on that query', async () => {
    // openHit → find.openWith(query, pageId): the FindBar opens seeded with the
    // query and reports the match — proving the click drives the shared find
    // session (highlight), not a bespoke path.
    await $('[data-testid="search-hit"]').click();
    await $('[data-testid="find-input"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'clicking a search hit did not open the find bar',
    });
    expect(await $('[data-testid="find-input"]').getValue()).toBe('revenue');
    await browser.waitUntil(
      async () => (await $('[data-testid="find-count"]').getText()).includes('match'),
      { timeout: 20_000, timeoutMsg: 'find highlight never reported a match for the clicked hit' },
    );
  });

  it('reports no matches for a term absent from the document', async () => {
    await setReactInputValue('[data-testid="search-input"]', 'zzznotpresent');
    await $('[data-testid="search-no-results"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'no-results state never showed',
    });
  });
});
