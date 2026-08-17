import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  closeAllFiles,
  focusTab,
  setView,
  setReactInputValue,
  invokeAppCommand,
} from '../support/harness.js';

/** A tiny born-digital PDF with known text — so Find has something real to hit. */
async function makeTextPdf(path: string, lines: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  let y = 350;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 16, font });
    y -= 30;
  }
  writeFileSync(path, await doc.save());
}

// The continuous reading Document view. Default is the Organize
// board; a pill toggles to the reading column, which hosts the SAME PageCells
// (the reuse seam). This proves the toggle both ways and that pages actually
// render (raster) in the column.
const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

describe('document view', () => {
  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening did not focus the doc tab',
    });
    await setView('canvas');
  });

  // A document now OPENS in the reading view. Pinned end-to-end (the
  // reducer test pins the state; this pins that it's what actually renders).
  it('opens in the reading view and renders pages', async () => {
    await $('[data-testid="document-view"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'a document did not open in the reading view',
    });
    // A page's raster cell mounts in the column (PageView renders when near).
    await browser.waitUntil(
      async () => (await $$('[data-testid="document-view"] .pageview').getElements()).length > 0,
      { timeout: 15_000, timeoutMsg: 'no page rendered in the reading view' },
    );
  });

  it('toggles to the Organize board and back', async () => {
    await $('[data-testid="toggle-doc-view"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="document-view"]').isExisting()), {
      timeout: 10_000,
      timeoutMsg: 'the board did not take over on toggle',
    });
    await $('[data-testid="toggle-doc-view"]').click();
    await $('[data-testid="document-view"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'the reading view did not come back on toggle',
    });
  });

  it('the floating zoom buttons resize pages in the reading view', async () => {
    // Discriminates the routing fix: the on-screen zoom cluster references the
    // ACTIVE view's handle, not the (unmounted, null) board camera — without it
    // the button is a silent no-op in Read mode and the page never resizes.
    const pageWidth = () =>
      browser.execute(() => {
        const el = document.querySelector('[data-testid="document-view"] .pageview');
        return el ? Math.round((el as HTMLElement).getBoundingClientRect().width) : 0;
      });
    const before = await pageWidth();
    expect(before).toBeGreaterThan(0);
    await $('button[title="Zoom in"]').click();
    await browser.waitUntil(async () => (await pageWidth()) > before, {
      timeout: 10_000,
      timeoutMsg: 'Zoom+ did not enlarge the page — the button is not routed to the reading view',
    });
  });

  it('shows a page indicator matching the document, and jumping scrolls', async () => {
    const pageCount = (await getState()).activeFile?.pageCount ?? 0;
    expect(pageCount).toBeGreaterThan(0);
    // The indicator's total matches the document.
    expect(await $('[data-testid="page-nav-total"]').getText()).toContain(`/ ${pageCount}`);
    if (pageCount < 2) return; // single-page fixture — no page below the fold to jump to
    const scrollTop = () =>
      browser.execute(
        () => (document.querySelector('[data-testid="document-view"]') as HTMLElement | null)?.scrollTop ?? 0,
      );
    const before = await scrollTop();
    await $('[data-testid="page-nav-box"]').click();
    await setReactInputValue('[data-testid="page-nav-box"]', String(pageCount));
    await browser.keys(['Enter']);
    await browser.waitUntil(async () => (await scrollTop()) > before, {
      timeout: 10_000,
      timeoutMsg: 'jumping to the last page did not scroll the reading view',
    });
  });

});

// gate: the reading view shows exactly ONE document, but Find matches
// workspace-wide. A match in ANOTHER open file must bring that file to the front
// and land on it — the bug this closed was a silent no-op while Find's own
// counter advanced, so the assertion has to be that the VIEW actually moved, not
// merely that Find found something.
describe('reading view: a Find match in another open file', () => {
  let tmp: string;
  let fileA: string;
  let fileB: string;
  const NEEDLE = 'ZYGOTEMARKER';

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'opds-e2e-xdoc-'));
    fileA = resolve(tmp, 'alpha.pdf');
    fileB = resolve(tmp, 'beta.pdf');
    // Only file B contains the needle.
    await makeTextPdf(fileA, ['ALPHA ONLY', 'NOTHING TO SEE']);
    await makeTextPdf(fileB, ['BETA DOCUMENT', NEEDLE]);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([fileA, fileB]);
    await browser.waitUntil(async () => (await getState()).fileCount === 2, {
      timeout: 10_000,
      timeoutMsg: 'both files never opened',
    });
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('focuses the other file and lands on the match, instead of silently doing nothing', async () => {
    // Read file A...
    await focusTab({ doc: fileA });
    await browser.waitUntil(async () => (await getState()).activeFile?.path === fileA, {
      timeout: 10_000,
      timeoutMsg: 'file A never became active',
    });
    // Just wait for it — a document opens in the reading view now. (Do NOT
    // "click the toggle if it isn't there": the view only mounts once the
    // workspace has INDEXED the file, so that check fires during the indexing
    // window and toggles away to the board instead.)
    await $('[data-testid="document-view"]').waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: 'file A did not open in the reading view',
    });

    // ...then Find a term that only exists in file B, and navigate to it.
    await invokeAppCommand('edit.find');
    await $('[data-testid="find-input"]').waitForDisplayed({ timeout: 10_000 });
    await setReactInputValue('[data-testid="find-input"]', NEEDLE);
    await browser.waitUntil(
      async () => (await $('[data-testid="find-count"]').getText()).match(/[1-9]/) !== null,
      { timeout: 15_000, timeoutMsg: 'Find never matched the needle in the other file' },
    );
    await $('[data-testid="find-next"]').click();

    // THE ASSERTION: the reading view actually moved to file B. The
    // counter used to advance while centerOn silently returned (the page
    // belonged to a document this view wasn't showing).
    await browser.waitUntil(async () => (await getState()).activeFile?.path === fileB, {
      timeout: 10_000,
      timeoutMsg: 'the Find jump did not bring the other file to the front — it no-oped',
    });
    // ...and it is still the reading view that is showing it.
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
  });
});

describe('two-up spread layout (I.6 page display)', () => {
  const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE]);
    await browser.waitUntil(async () => (await getState()).activeFile !== null, {
      timeoutMsg: 'sample.pdf did not open',
    });
    await setView('canvas');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  after(async () => {
    // Leave the shared session in the default layout for later specs.
    await invokeAppCommand('view.singlePage');
  });

  /** [top, left] of every mounted page cell, sorted by top then left. */
  async function cellBoxes(): Promise<{ id: string; top: number; left: number }[]> {
    return await browser.execute(() => {
      const cells = Array.from(
        document.querySelectorAll('[data-testid="document-view"] .docview-row [data-page-id]'),
      ) as HTMLElement[];
      return cells
        .map((c) => {
          const r = c.getBoundingClientRect();
          return { id: c.dataset.pageId as string, top: Math.round(r.top), left: Math.round(r.left) };
        })
        .sort((a, b) => a.top - b.top || a.left - b.left);
    });
  }

  it('two-up pairs pages side by side, cover alone (the book convention)', async () => {
    expect(await invokeAppCommand('view.twoUp')).toBe(true);
    await browser.waitUntil(
      async () => {
        const boxes = await cellBoxes();
        if (boxes.length < 3) return false;
        // Cover row: page 1 alone (no cell sharing its top). Next row: two
        // cells at the SAME top with DIFFERENT lefts — a real spread.
        const tops = boxes.map((b) => b.top);
        const coverAlone = tops.filter((t) => t === tops[0]).length === 1;
        const second = boxes.filter((b) => b.top === boxes[1].top);
        return coverAlone && second.length === 2 && second[0].left !== second[1].left;
      },
      { timeout: 10_000, timeoutMsg: 'two-up spread never laid out as cover + facing pair' },
    );
  });

  // NOTE: runs while twoUpCover is still ON (the default) — cover-off has one
  // row fewer, the stale scrollTop then exceeds the new max, the browser clamp
  // moves it, and the anchor drops for the WRONG reason (geometry, not the
  // fix), leaving the mutation invisible. Order is load-bearing.
  it('a jump anchor does not survive a layout switch (regression)', async () => {
    // Needs a document long enough that the stale page's
    // row falls OUT of the viewport): jump to page 5 of 10 in single layout,
    // switch to two-up without scrolling. The layout remaps rows under the
    // unchanged scrollTop; a surviving anchor kept the box saying "5" while
    // the pane showed pages 8-9 and page 5's cell wasn't even mounted. After
    // the fix the box must name a page whose cell is actually on screen.
    const tmp = mkdtempSync(resolve(tmpdir(), 'opds-e2e-anchor-'));
    try {
      const long = resolve(tmp, 'ten.pdf');
      const doc10 = await PDFDocument.create();
      for (let i = 0; i < 10; i++) doc10.addPage([612, 792]);
      writeFileSync(long, await doc10.save());
      await closeAllFiles();
      await openByPaths([long]);
      await setView('canvas');
      await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
      await invokeAppCommand('view.singlePage');
      // Zoom out so the two-up SPREAD will fit the pane width. Without this the
      // spread overflows, a horizontal scrollbar appears, clientHeight shrinks,
      // and the anchor's viewportH check drops it BY ACCIDENT — masking the bug
      // (the mutation check caught exactly that: the pin passed with the fix
      // disabled). The real-world exposure is any window wide enough for the
      // spread — this makes the pin that window.
      await invokeAppCommand('view.zoomOut');
      await invokeAppCommand('view.zoomOut');
      await invokeAppCommand('view.zoomOut');
      await browser.pause(300); // let the zoom settle before the jump records rowH

      await $('[data-testid="page-nav-box"]').click();
      await setReactInputValue('[data-testid="page-nav-box"]', '5');
      await browser.keys(['Enter']);
      await browser.waitUntil(
        async () => (await $('[data-testid="page-nav-box"]').getValue()) === '5',
        { timeout: 10_000, timeoutMsg: 'jump to page 5 never registered' },
      );

      await invokeAppCommand('view.twoUp');
      // FIRST wait for the two-up DOM to actually land — polling before the
      // re-render sees the old single-page frame, where the stale answer is
      // still legitimately visible and the assertion passes vacuously (the
      // mutation check caught exactly this race).
      await browser.waitUntil(
        async () =>
          await browser.execute(() => {
            const view = document.querySelector('[data-testid="document-view"]') as HTMLElement | null;
            if (!view) return false;
            const cells = Array.from(view.querySelectorAll('.docview-row [data-page-id]')) as HTMLElement[];
            const tops = cells.map((c) => Math.round(c.getBoundingClientRect().top));
            return tops.some((t, i) => tops.indexOf(t) !== i); // some row holds TWO cells
          }),
        { timeout: 10_000, timeoutMsg: 'two-up layout never rendered' },
      );
      // The honest post-switch readout is a page whose cell the pane actually
      // shows. Under the bug ui.currentPageId durably stayed page 5 while page
      // 5's cell sat far off-screen. Assert on the STATE (the anchor's actual
      // output), not the page box — the box keeps a local draft while focused,
      // which would mask both outcomes.
      await browser.waitUntil(
        async () => {
          const currentPageId = (await getState()).currentPageId;
          if (!currentPageId) return false;
          return await browser.execute((id: string) => {
            const view = document.querySelector('[data-testid="document-view"]') as HTMLElement | null;
            if (!view) return false;
            const vr = view.getBoundingClientRect();
            // Match by dataset, NOT a CSS attribute selector — page ids are
            // Windows paths and their backslashes are CSS escape characters.
            const cell = (Array.from(view.querySelectorAll('.docview-row [data-page-id]')) as HTMLElement[])
              .find((c) => c.dataset.pageId === id);
            if (!cell) return false; // reported page isn't even mounted → stale
            const r = cell.getBoundingClientRect();
            return r.bottom > vr.top + 1 && r.top < vr.bottom - 1;
          }, currentPageId);
        },
        {
          timeout: 10_000,
          timeoutMsg: 'after the layout switch the current page is not on screen (stale anchor)',
        },
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      // Restore the suite's shared fixture + default layout for later tests.
      await invokeAppCommand('view.singlePage');
      await closeAllFiles();
      await openByPaths([SAMPLE]);
      await setView('canvas');
      await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
    }
  });

  it('facing pairs without the cover option pair (1,2)(3,4)…', async () => {
    // Self-sufficient: the anchor test above restores single-page layout, and
    // the cover toggle is gated on two-up being active.
    expect(await invokeAppCommand('view.twoUp')).toBe(true);
    expect(await invokeAppCommand('view.twoUpCover')).toBe(true); // toggle cover OFF
    await browser.waitUntil(
      async () => {
        const boxes = await cellBoxes();
        if (boxes.length < 2) return false;
        const firstRow = boxes.filter((b) => b.top === boxes[0].top);
        return firstRow.length === 2; // pages 1+2 now share the first row
      },
      { timeout: 10_000, timeoutMsg: 'cover toggle did not re-pair the first row' },
    );
  });

  it('single page restores the one-per-row column', async () => {
    expect(await invokeAppCommand('view.singlePage')).toBe(true);
    await browser.waitUntil(
      async () => {
        const boxes = await cellBoxes();
        const tops = new Set(boxes.map((b) => b.top));
        return boxes.length >= 2 && tops.size === boxes.length; // every cell on its own row
      },
      { timeout: 10_000, timeoutMsg: 'single-page layout did not restore' },
    );
  });
});

describe('reading mode (I.6 chrome collapse)', () => {
  const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE]);
    await setView('canvas');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  it('Ctrl+H collapses the chrome and Esc restores it', async () => {
    // Chrome present before.
    expect(await $('[data-testid="tab-strip"]').isExisting()).toBe(true);

    expect(await invokeAppCommand('view.readingMode')).toBe(true);
    await browser.waitUntil(
      async () => !(await $('[data-testid="tab-strip"]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'reading mode did not hide the tab strip' },
    );
    // The document itself is still there — the mode collapses chrome, not content.
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);

    // Escape leaves reading mode and the chrome returns.
    await browser.keys(['Escape']);
    await browser.waitUntil(
      async () => await $('[data-testid="tab-strip"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'Escape did not restore the chrome' },
    );
  });

  it('leaving the doc tab clears reading mode (Home keeps its chrome)', async () => {
    expect(await invokeAppCommand('view.readingMode')).toBe(true);
    await browser.waitUntil(
      async () => !(await $('[data-testid="tab-strip"]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'reading mode did not engage' },
    );
    await focusTab('home');
    await browser.waitUntil(
      async () => await $('[data-testid="tab-strip"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'Home tab lost its chrome — reading mode leaked off the doc tab' },
    );
  });
});

describe('presentation mode (I.6 full-screen view)', () => {
  const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE]);
    await browser.waitUntil(async () => (await getState()).activeFile !== null, {
      timeoutMsg: 'sample.pdf did not open',
    });
    await setView('canvas');
    // Wait for the reading view to actually mount (workspace indexed) — the
    // command reads workspace.documents, which is populated after indexing.
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  it('F5 command opens a full-screen overlay, navigates, and Escape restores', async () => {
    const before = await getState();
    const pages = before.activeFile?.pageCount ?? 0;
    expect(pages).toBeGreaterThan(1);

    // Enable = a document is open (the command's `when`).
    expect(await invokeAppCommand('view.presentation')).toBe(true);
    const overlay = $('[data-testid="presentation-view"]');
    await overlay.waitForDisplayed({ timeout: 10_000, timeoutMsg: 'presentation overlay never appeared' });

    // Counter starts at 1/N; a click (projector convention) advances it.
    const counter = $('[data-testid="presentation-counter"]');
    expect(await counter.getText()).toBe(`1 / ${pages}`);
    await overlay.click();
    await browser.waitUntil(async () => (await counter.getText()) === `2 / ${pages}`, {
      timeout: 5_000,
      timeoutMsg: 'a click did not advance the slide',
    });

    // The exit affordance closes it, and the app is restored underneath.
    await $('[data-testid="presentation-exit"]').click();
    await browser.waitUntil(async () => !(await overlay.isExisting()), {
      timeout: 5_000,
      timeoutMsg: 'presentation overlay did not close',
    });
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
  });

  it('is disabled with no document open', async () => {
    await closeAllFiles();
    await browser.waitUntil(async () => (await getState()).activeFile === null, {
      timeoutMsg: 'files did not close',
    });
    // Disabled → the command does not run (no overlay).
    expect(await invokeAppCommand('view.presentation')).toBe(false);
    expect(await $('[data-testid="presentation-view"]').isExisting()).toBe(false);
  });
});
