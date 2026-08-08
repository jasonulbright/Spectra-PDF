import { resolve } from 'node:path';
import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  getState,
  splitRun,
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

async function makeFixture(path: string, pages: number): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([300, 300]);
    // Enough incompressible padding that a size cap has something to divide.
    page.drawText(`PAGE ${i} ${Math.random().toString(36).repeat(40)}`, {
      x: 10, y: 150, size: 6, font,
    });
  }
  writeFileSync(path, await doc.save());
}

async function pageCount(path: string): Promise<number> {
  const doc = await PDFDocument.load(readFileSync(path));
  return doc.getPageCount();
}

describe('the split panel offers four modes', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-split-'));
    source = resolve(tmp, 'split-me.pdf');
    await makeFixture(source, 6);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('shows the field each mode needs and hides the others', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('split');

    // Ranges is the default and keeps the shipped field.
    expect(await $('[data-testid="split-ranges"]').isExisting()).toBe(true);
    expect(await $('[data-testid="split-every-n"]').isExisting()).toBe(false);
    expect(await $('[data-testid="split-max-mb"]').isExisting()).toBe(false);

    await setReactSelectValue('[data-testid="split-mode"]', 'every_n');
    await browser.waitUntil(async () => $('[data-testid="split-every-n"]').isExisting(), {
      timeout: 5_000,
      timeoutMsg: 'the pages-per-file field never appeared',
    });
    expect(await $('[data-testid="split-ranges"]').isExisting()).toBe(false);

    await setReactSelectValue('[data-testid="split-mode"]', 'size');
    await browser.waitUntil(async () => $('[data-testid="split-max-mb"]').isExisting(), {
      timeout: 5_000,
      timeoutMsg: 'the maximum-size field never appeared',
    });
    expect(await $('[data-testid="split-every-n"]').isExisting()).toBe(false);

    await setReactSelectValue('[data-testid="split-mode"]', 'bookmarks');
    await browser.waitUntil(async () => $('[data-testid="split-bookmark-note"]').isExisting(), {
      timeout: 5_000,
      timeoutMsg: 'the bookmark note never appeared',
    });
    expect(await $('[data-testid="split-max-mb"]').isExisting()).toBe(false);
  });

  it('says a document has no top-level bookmarks BEFORE the run, and disables the button', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('split');
    await setReactSelectValue('[data-testid="split-mode"]', 'bookmarks');

    // The refusal is knowable from the document, so it is reported without
    // asking the user to run something that cannot succeed.
    await browser.waitUntil(
      async () => {
        const note = await $('[data-testid="split-bookmark-note"]').getText();
        return note.length > 0 && !note.includes('…');
      },
      { timeout: 10_000, timeoutMsg: 'the bookmark count never resolved' },
    );
    expect(await $('[data-testid="split-run"]').isEnabled()).toBe(false);
  });

  it('range mode still writes the file it always wrote', async () => {
    const dir = resolve(tmp, 'ranges');
    mkdirSync(dir, { recursive: true });
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('split');

    // The panel is not remounted between opens, so the mode a previous case
    // left is still selected — every case names the mode it wants.
    await setReactSelectValue('[data-testid="split-mode"]', 'ranges');
    await setReactInputValue('[data-testid="split-ranges"]', '1-3');
    expect(await splitRun(dir)).toBe('');
    expect(readdirSync(dir)).toEqual(['split_1-3.pdf']);
    expect(await pageCount(resolve(dir, 'split_1-3.pdf'))).toBe(3);
    // A split writes new files; the open document is untouched.
    expect((await getState()).activeFile?.dirty).not.toBe(true);
  });

  it('every-n writes one file per group, the last holding the remainder', async () => {
    const dir = resolve(tmp, 'everyn');
    mkdirSync(dir, { recursive: true });
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('split');

    await setReactSelectValue('[data-testid="split-mode"]', 'every_n');
    await setReactInputValue('[data-testid="split-every-n"]', '4');
    expect(await splitRun(dir)).toBe('');

    const written = readdirSync(dir).sort();
    expect(written).toEqual(['split-me_1-4.pdf', 'split-me_5-6.pdf']);
    expect(await pageCount(resolve(dir, 'split-me_1-4.pdf'))).toBe(4);
    expect(await pageCount(resolve(dir, 'split-me_5-6.pdf'))).toBe(2);
    expect(await $('[data-testid="status-bar"]').getText()).toContain('6');
  });

  it('size mode writes every part under the cap', async () => {
    const dir = resolve(tmp, 'bysize');
    mkdirSync(dir, { recursive: true });
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('split');

    await setReactSelectValue('[data-testid="split-mode"]', 'size');
    await setReactInputValue('[data-testid="split-max-mb"]', '0.002');
    expect(await splitRun(dir)).toBe('');

    const written = readdirSync(dir);
    expect(written.length).toBeGreaterThan(1);
    let pages = 0;
    for (const name of written) pages += await pageCount(resolve(dir, name));
    expect(pages).toBe(6);
  });
});
