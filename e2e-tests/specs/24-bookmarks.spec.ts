import { resolve } from 'node:path';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, getState, closeAllFiles, setReactInputValue } from '../support/harness.js';

// bookmarked.pdf: outline = Chapter 1 [Section 1.1, Section 1.2], Chapter 2.
const BOOKMARKED_PDF = resolve(__dirname, '..', 'fixtures', 'bookmarked.pdf');

// Phase 4 M3.2: the merged Bookmarks nav panel (OutlineSidebar's reorder+jump +
// OutlinePanel's editing, one surface). Drives the real DOM: display, inline
// rename with a disk round-trip, and add.

async function ensureBookmarksOpen(): Promise<void> {
  const pressed = await $('[data-testid="navicon-bookmarks"]').getAttribute('aria-pressed');
  if (pressed !== 'true') await $('[data-testid="navicon-bookmarks"]').click();
  await $('[data-testid="bookmarks-panel"]').waitForDisplayed({ timeoutMsg: 'bookmarks panel did not open' });
}

async function firstTitle(): Promise<string> {
  return await $('[data-testid="bookmark-title"]').getValue();
}

describe('navigation pane — Bookmarks panel', () => {
  let workingCopy: string;

  before(async () => {
    // A per-run copy so the rename mutation doesn't dirty the shared fixture.
    const dir = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-bm-'));
    workingCopy = resolve(dir, 'bookmarked.pdf');
    copyFileSync(BOOKMARKED_PDF, workingCopy);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([workingCopy]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening did not focus the doc tab',
    });
  });

  it('shows the document’s existing bookmarks', async () => {
    await ensureBookmarksOpen();
    await $('[data-testid="bookmark-row"]').waitForDisplayed({ timeoutMsg: 'no bookmarks rendered' });
    const titles = await $$('[data-testid="bookmark-title"]').map((el) => el.getValue());
    expect(titles).toContain('Chapter 1');
    expect(titles).toContain('Chapter 2');
  });

  it('renames a bookmark inline and persists to disk', async () => {
    // Focus the input first, then set the value, then Enter — the input's
    // onKeyDown(Enter) blurs it, and only a real blur (from a focused field)
    // fires onBlur → commit → save.
    await $('[data-testid="bookmark-title"]').click();
    await setReactInputValue('[data-testid="bookmark-title"]', 'E2E RENAMED');
    await browser.keys(['Enter']);
    // Round-trip through disk: switch panel away and back forces a remount that
    // reloads the outline from the file — proving the save landed.
    await $('[data-testid="navicon-pages"]').click();
    await $('[data-testid="pages-panel"]').waitForDisplayed();
    await $('[data-testid="navicon-bookmarks"]').click();
    await $('[data-testid="bookmark-row"]').waitForDisplayed();
    await browser.waitUntil(async () => (await firstTitle()) === 'E2E RENAMED', {
      timeout: 10_000,
      timeoutMsg: 'renamed bookmark did not persist across a reload',
    });
  });

  it('adds a new bookmark', async () => {
    const before = (await $$('[data-testid="bookmark-row"]')).length;
    await $('[data-testid="bookmark-add"]').click();
    await browser.waitUntil(
      async () => (await $$('[data-testid="bookmark-row"]')).length === before + 1,
      { timeoutMsg: 'add bookmark did not create a row' },
    );
  });
});
