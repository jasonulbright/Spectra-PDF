import { resolve } from 'node:path';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  closeAllFiles,
  setView,
  setActiveOp,
  getOutlineOrder,
  getArticles,
  addArticleBead,
  saveArticles,
} from '../support/harness.js';

// derived-nav.pdf: two tagged pages. Page 1 = H1 "Introduction" + H2 "Scope
// and purpose"; page 2 = H1 "References" + a line carrying
// https://example.com/spec and editor@example.org.
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'derived-nav.pdf');

// P29 — navigation DERIVED from the document's own content, end to end
// through the real binary: bookmarks from the structure tree, links from the
// addresses in the text, and an article thread authored and persisted.

async function openNav(panel: string, testId: string): Promise<void> {
  const pressed = await $(`[data-testid="navicon-${panel}"]`).getAttribute('aria-pressed');
  if (pressed !== 'true') await $(`[data-testid="navicon-${panel}"]`).click();
  await $(`[data-testid="${testId}"]`).waitForDisplayed({
    timeoutMsg: `${panel} panel did not open`,
  });
}

describe('derived navigation', () => {
  let workingCopy: string;

  before(async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-p29-'));
    workingCopy = resolve(dir, 'derived-nav.pdf');
    copyFileSync(FIXTURE, workingCopy);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([workingCopy]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening did not focus the doc tab',
    });
  });

  it('builds bookmarks from the tagged headings', async () => {
    await openNav('bookmarks', 'bookmarks-panel');
    // The document starts with no bookmarks at all.
    expect(await getOutlineOrder()).toEqual([]);

    await $('[data-testid="bookmarks-from-structure"]').click();
    const state = await $('[data-testid="bookmarks-derive-state"]');
    await state.waitForDisplayed({ timeoutMsg: 'the structure preview did not appear' });
    // Counted BEFORE anything is written — the hairlines contract.
    expect(await state.getText()).toContain('3');

    await $('[data-testid="bookmarks-derive-build"]').click();
    await browser.waitUntil(async () => (await getOutlineOrder()).length === 3, {
      timeout: 20_000,
      timeoutMsg: 'the derived bookmarks never landed',
    });

    const order = await getOutlineOrder();
    expect(order.map((n) => n.title)).toEqual([
      'Introduction',
      'Scope and purpose',
      'References',
    ]);
    // The H2 nests under its H1; the second H1 returns to the top level.
    expect(order.map((n) => n.depth)).toEqual([0, 1, 0]);
    expect(order.map((n) => n.page)).toEqual([1, 1, 2]);
  });

  it('creates links over the web and email addresses in the text', async () => {
    await setView('operations');
    await setActiveOp('links');
    await $('[data-testid="links-derive"]').waitForDisplayed({
      timeoutMsg: 'the links panel did not open',
    });
    // Nothing is linked yet.
    await $('[data-testid="links-empty"]').waitForDisplayed({
      timeoutMsg: 'the document already had links',
    });

    await $('[data-testid="links-derive-find"]').click();
    const count = await $('[data-testid="links-derive-count"]');
    await count.waitForDisplayed({ timeoutMsg: 'the address count never appeared' });
    expect(await count.getText()).toContain('2');

    await $('[data-testid="links-derive-create"]').click();
    await $('[data-testid="links-list"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'the created links never appeared',
    });
    await browser.waitUntil(
      async () => (await $$('[data-testid="link-item"]').length) === 2,
      { timeout: 20_000, timeoutMsg: 'expected exactly two links' },
    );
    const targets = await $$('[data-testid="link-item"]').map((el) => el.getText());
    expect(targets.join(' ')).toContain('https://example.com/spec');
    expect(targets.join(' ')).toContain('mailto:editor@example.org');
  });

  it('re-running finds the same addresses and creates nothing', async () => {
    await $('[data-testid="links-derive-find"]').click();
    const count = await $('[data-testid="links-derive-count"]');
    await browser.waitUntil(async () => (await count.getText()).includes('2'), {
      timeoutMsg: 'the second scan never reported',
    });
    // Both are already linked, so Create is not offered.
    expect(await $('[data-testid="links-derive-create"]').isEnabled()).toBe(false);
    expect(await $$('[data-testid="link-item"]').length).toBe(2);
  });

  it('authors an article thread and saves it into the document', async () => {
    await openNav('articles', 'articles-panel');
    await $('[data-testid="articles-empty"]').waitForDisplayed({
      timeoutMsg: 'the articles panel did not open empty',
    });

    await $('[data-testid="article-add"]').click();
    await $('[data-testid="article-row"]').waitForDisplayed({
      timeoutMsg: 'the new article did not appear',
    });
    // The band gesture lives inside transformed canvas space; the panel's own
    // append is what a drawn box reaches, so the spec drives that.
    await addArticleBead(1, [72, 600, 300, 730]);
    await addArticleBead(2, [72, 600, 300, 730]);
    await browser.waitUntil(async () => (await getArticles())[0]?.beads.length === 2, {
      timeoutMsg: 'the drawn boxes never reached the article',
    });

    await saveArticles();
    await browser.waitUntil(
      async () => {
        const rows = await getArticles();
        return rows.length === 1 && rows[0].beads.length === 2;
      },
      { timeout: 20_000, timeoutMsg: 'the article did not survive the save' },
    );
    const saved = await getArticles();
    expect(saved[0].beads.map((b) => b.page)).toEqual([1, 2]);
  });

  it('appends a bead drawn on the page with the real band gesture', async () => {
    // The panel append above cannot see the gesture that feeds it: the band's
    // release hands the box to a callback the page cell receives as a prop, so
    // a render path that fails to pass it draws the band, finishes the drag,
    // and appends nothing. Pointer events through the real component tree are
    // the only thing that reads that.
    const before = (await getArticles())[0].beads.length;

    await openNav('articles', 'articles-panel');
    await $('[data-testid="article-row"]').click();
    const draw = await $('[data-testid="article-draw"]');
    await draw.click();
    await browser.waitUntil(async () => (await getState()).tool === 'beaddraw', {
      timeout: 10_000,
      timeoutMsg: 'the Draw button never armed the bead mode',
    });

    const pr = (await browser.execute(function () {
      const el = document.querySelector('[data-page-id]');
      if (!el) return null as unknown as { x: number; y: number; w: number; h: number };
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })) as { x: number; y: number; w: number; h: number };
    expect(pr).not.toBe(null);
    const at = (fx: number, fy: number): { x: number; y: number } => ({
      x: Math.round(pr.x + pr.w * fx),
      y: Math.round(pr.y + pr.h * fy),
    });
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move(at(0.35, 0.2))
      .down()
      .pause(80)
      .move(at(0.5, 0.32))
      .pause(80)
      .move(at(0.7, 0.45))
      .pause(80)
      .up()
      .perform();

    await browser.waitUntil(async () => (await getArticles())[0].beads.length === before + 1, {
      timeout: 10_000,
      timeoutMsg: 'the drawn box never reached the article',
    });
    const bead = (await getArticles())[0].beads[before];
    expect(bead.page).toBe(1);
    // A box, not a click: the band covers real area in page space.
    expect(bead.rect[2] - bead.rect[0]).toBeGreaterThan(1);
    expect(bead.rect[3] - bead.rect[1]).toBeGreaterThan(1);
  });
});
