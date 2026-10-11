import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  clearViewHistory,
  closeAllFiles,
  readingViewDom,
  readingWheel,
  waitForReadingView,
} from '../support/harness.js';

// Spreadsheet Split uses a 2×2 grid over one document with frozen-pane
// semantics: panes in a row share
// vertical scroll, panes in a column share horizontal scroll, zoom
// broadcasts. Driven through the real command + real DOM scrollers.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

const SCROLLER = (pane: string): string =>
  `[data-testid="doc-pane-${pane}"] [data-testid="document-view"]`;

async function setScroll(pane: string, prop: 'scrollTop' | 'scrollLeft', v: number): Promise<void> {
  await browser.execute(
    (sel: string, pr: string, val: number) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) (el as unknown as Record<string, number>)[pr] = val;
    },
    SCROLLER(pane),
    prop,
    v,
  );
}

async function getScroll(pane: string, prop: 'scrollTop' | 'scrollLeft'): Promise<number> {
  return (await browser.execute(
    (sel: string, pr: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? (el as unknown as Record<string, number>)[pr] : -1;
    },
    SCROLLER(pane),
    prop,
  )) as number;
}

describe('spreadsheet split (quad, frozen-pane links)', () => {
  before(async () => {
    await waitForHarness();
    await clearViewHistory();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
    if ((await getState()).splitMode !== 'off') {
      await invokeAppCommand('window.split'); // normalize from any prior state
    }
  });

  after(async () => {
    if ((await getState()).splitMode !== 'off') {
      const mode = (await getState()).splitMode;
      await invokeAppCommand(mode === 'quad' ? 'window.spreadsheetSplit' : 'window.split');
    }
    await closeAllFiles();
    await clearViewHistory();
  });

  it('window.spreadsheetSplit shows four panes of the same document', async () => {
    expect(await invokeAppCommand('window.spreadsheetSplit')).toBe(true);
    await browser.waitUntil(async () => (await getState()).splitMode === 'quad', {
      timeoutMsg: 'the command did not enter quad mode',
    });
    await $('[data-testid="quad-container"]').waitForDisplayed({ timeout: 10_000 });
    for (const p of ['a', 'b', 'c', 'd']) {
      await expect($(SCROLLER(p))).toBeDisplayed();
    }
  });

  it('panes in a ROW share vertical scroll; the column partner does not follow it', async () => {
    await setScroll('a', 'scrollTop', 240);
    await browser.waitUntil(async () => (await getScroll('b', 'scrollTop')) === 240, {
      timeout: 5_000,
      timeoutMsg: "pane b (a's row partner) never mirrored scrollTop",
    });
    expect(await getScroll('c', 'scrollTop')).toBe(0); // column partner: left only
  });

  it('after a broadcast zoom, panes in a COLUMN share horizontal scroll', async () => {
    // Zoom until the page is wider than a half-width pane — the zoom
    // commands broadcast to all four panes in quad mode.
    for (let i = 0; i < 12; i++) {
      const a = await readingViewDom('[data-testid="doc-pane-a"]');
      if (a && a.scrollWidth > a.clientWidth + 120) break;
      expect(await invokeAppCommand('view.zoomIn')).toBe(true);
      await browser.pause(150);
    }
    await waitForReadingView(
      (v) => v.scrollWidth > v.clientWidth + 120,
      'zooming in never made the page wider than the pane',
      { scope: '[data-testid="doc-pane-a"]' },
    );
    // A stepped zoom anchors at each pane's own centre, so no pane is at
    // scrollLeft 0 here. The row partner must not MOVE when a scrolls.
    await browser.pause(400);
    const bLeft = await getScroll('b', 'scrollLeft');
    const target = Math.round(await getScroll('a', 'scrollLeft')) === 60 ? 100 : 60;
    await browser.waitUntil(
      async () => {
        await setScroll('a', 'scrollLeft', target);
        return (await getScroll('c', 'scrollLeft')) === target;
      },
      { timeout: 10_000, timeoutMsg: "pane c (a's column partner) never mirrored scrollLeft" },
    );
    expect(await getScroll('b', 'scrollLeft')).toBe(bLeft); // row partner: top only
  });

  it('page layout and scrolling broadcast to all four panes', async () => {
    // Equal geometry keeps the frozen-row and frozen-column links aligned, so
    // the quad applies a layout or scrolling change to every pane.
    expect(await invokeAppCommand('view.multiPage')).toBe(true);
    expect(await invokeAppCommand('view.scrollPaged')).toBe(true);
    for (const p of ['a', 'b', 'c', 'd']) {
      await waitForReadingView(
        (v) => v.layoutMode === 'grid' && v.scrollMode === 'paged',
        `pane ${p} did not receive the layout and scrolling change`,
        { scope: `[data-testid="doc-pane-${p}"]` },
      );
    }
    expect(await invokeAppCommand('view.singlePage')).toBe(true);
    expect(await invokeAppCommand('view.scrollContinuous')).toBe(true);
    for (const p of ['a', 'b', 'c', 'd']) {
      await waitForReadingView(
        (v) => v.layoutMode === 'single' && v.scrollMode === 'continuous',
        `pane ${p} did not return to single continuous`,
        { scope: `[data-testid="doc-pane-${p}"]` },
      );
    }
  });

  it('toggling off restores exactly one view', async () => {
    expect(await invokeAppCommand('window.spreadsheetSplit')).toBe(true);
    await browser.waitUntil(async () => (await getState()).splitMode === 'off', {
      timeoutMsg: 'the quad never toggled off',
    });
    await $('[data-testid="quad-container"]').waitForExist({ reverse: true, timeout: 5_000 });
    await expect($('[data-testid="document-view"]')).toBeDisplayed();
  });
});

// Content alignment: the quad's panes share one resolved geometry, so linked
// panes show the same content at the same place. Raw scroll equality does not
// prove it: each pane would otherwise resolve fits and grid columns against
// its own size, and one scroll offset would show different pages.

const PANES = ['a', 'b', 'c', 'd'] as const;
type Pane = (typeof PANES)[number];
const PANE = (p: Pane): string => `[data-testid="doc-pane-${p}"]`;
const ROW_PARTNERS: [Pane, Pane][] = [['a', 'b'], ['c', 'd']];
const COLUMN_PARTNERS: [Pane, Pane][] = [['a', 'c'], ['b', 'd']];

async function makeLetterPdf(path: string, pages: number): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    doc.addPage([612, 792]).drawText(`Page ${i}`, { x: 72, y: 700, size: 48, font });
  }
  writeFileSync(path, await doc.save());
}

interface QuadPane {
  zoomMode: string | null;
  zoomPercent: number;
  layoutMode: string | null;
  columns: number;
  currentPage: number;
  clientWidth: number;
  clientHeight: number;
  scrollHeight: number;
  cells: { id: string; left: number; top: number; width: number }[];
}
type Quad = Record<Pane, QuadPane>;

/** All four panes in one script run, so every comparison is of one instant. */
async function quadNow(): Promise<Quad | null> {
  return await browser.execute(function (panes: readonly string[]) {
    const out: Record<string, unknown> = {};
    for (const p of panes) {
      const el = document.querySelector(
        `[data-testid="doc-pane-${p}"] [data-testid="document-view"]`,
      ) as HTMLElement | null;
      if (!el) return null;
      const num = (name: string): number => {
        const v = el.getAttribute(name);
        return v === null ? Number.NaN : Number(v);
      };
      const cells = (Array.from(el.querySelectorAll('.docview-row [data-page-id]')) as HTMLElement[]).map((c) => {
        const page = (c.querySelector('.pageview') as HTMLElement | null) ?? c;
        const r = page.getBoundingClientRect();
        return { id: c.dataset.pageId as string, left: r.left, top: r.top, width: r.width };
      });
      out[p] = {
        zoomMode: el.getAttribute('data-zoom-mode'),
        zoomPercent: num('data-zoom-percent'),
        layoutMode: el.getAttribute('data-layout-mode'),
        columns: num('data-columns'),
        currentPage: num('data-current-page'),
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        cells,
      };
    }
    return out;
  }, PANES) as Quad | null;
}

async function waitForQuad(predicate: (q: Quad) => boolean, timeoutMsg: string): Promise<Quad> {
  let last: Quad | null = null;
  try {
    await browser.waitUntil(
      async () => {
        last = await quadNow();
        return last !== null && predicate(last);
      },
      { timeout: 10_000, interval: 100 },
    );
  } catch {
    throw new Error(`${timeoutMsg}; last read: ${JSON.stringify(last)}`);
  }
  return last!;
}

const distinctLefts = (p: QuadPane): number[] =>
  [...new Set(p.cells.map((c) => Math.round(c.left)))].sort((x, y) => x - y);

/** The reason linked panes disagree on content, or null when they agree:
 * equal columns everywhere; row partners on one page with every shared page
 * cell at one top; column partners with their cells at the same lefts. */
function misalignment(q: Quad): string | null {
  if (PANES.some((p) => q[p].columns !== q.a.columns)) return 'unequal columns';
  for (const [x, y] of ROW_PARTNERS) {
    if (q[x].currentPage !== q[y].currentPage) return `${x}/${y} current page`;
    const shared = q[x].cells.filter((c) => q[y].cells.some((d) => d.id === c.id));
    if (shared.length === 0) return `${x}/${y} share no mounted page`;
    for (const c of shared) {
      const d = q[y].cells.find((e) => e.id === c.id)!;
      if (Math.abs(c.top - d.top) > 1) return `${x}/${y} page top`;
    }
  }
  for (const [x, y] of COLUMN_PARTNERS) {
    const lx = distinctLefts(q[x]);
    const ly = distinctLefts(q[y]);
    if (lx.length === 0 || lx.length !== ly.length) return `${x}/${y} column count of lefts`;
    if (lx.some((l, i) => Math.abs(l - ly[i]) > 1)) return `${x}/${y} page left`;
  }
  return null;
}

/** Scroll one pane to a fraction of its range and wait for the quad to agree,
 * past the first few pages so a coincidence at the top cannot pass. */
async function scrollAndExpectAligned(pane: 'a' | 'c', fraction: number, what: string): Promise<void> {
  const view = (await quadNow())![pane];
  await setScroll(pane, 'scrollTop', Math.round((view.scrollHeight - view.clientHeight) * fraction));
  await waitForQuad(
    (q) => q[pane].currentPage >= 4 && misalignment(q) === null,
    `${what}: the panes do not show aligned content after pane ${pane} scrolled`,
  );
}

/**
 * Drag one quad divider until `moved` holds, at most three times. The two
 * dividers cross at the centre of the quad and the row divider is on top
 * there, so the grab point is a quarter of the way along the divider and is
 * hit-tested to be the requested divider before the press.
 */
async function dragQuadDivider(
  axis: 'col' | 'row',
  toFraction: number,
  moved: (q: Quad) => boolean,
  what: string,
): Promise<void> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const geometry = await browser.execute(function (testid: string, ax: string) {
      const divider = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
      const container = document.querySelector('[data-testid="quad-container"]') as HTMLElement | null;
      if (!divider || !container) return null;
      const d = divider.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      for (const along of [0.25, 0.75, 0.15, 0.85]) {
        const x = ax === 'col' ? d.left + d.width / 2 : d.left + d.width * along;
        const y = ax === 'col' ? d.top + d.height * along : d.top + d.height / 2;
        if (document.elementFromPoint(x, y) === divider) {
          return { x, y, left: c.left, top: c.top, width: c.width, height: c.height };
        }
      }
      return null;
    }, `quad-divider-${axis}`, axis);
    expect(geometry).not.toBeNull();
    const g = geometry!;
    const from = { x: Math.round(g.x), y: Math.round(g.y) };
    const to =
      axis === 'col'
        ? { x: Math.round(g.left + g.width * toFraction), y: from.y }
        : { x: from.x, y: Math.round(g.top + g.height * toFraction) };
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move(from)
      .down()
      .pause(60)
      .move({ x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) })
      .pause(60)
      .move(to)
      .pause(150)
      .up()
      .perform();
    try {
      await browser.waitUntil(
        async () => {
          const q = await quadNow();
          last = q;
          return q !== null && moved(q);
        },
        { timeout: 3_000, interval: 100 },
      );
      return;
    } catch {
      /* the next attempt re-reads the divider's position */
    }
  }
  throw new Error(`${what} after three drags; last read: ${JSON.stringify(last)}`);
}

describe('spreadsheet split (content alignment)', () => {
  let tmp = '';

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-quad-'));
    const letter = resolve(tmp, 'letter-24.pdf');
    await makeLetterPdf(letter, 24);
    await waitForHarness();
    await closeAllFiles();
    await clearViewHistory();
    await openByPaths([letter]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening the letter document did not land on canvas',
    });
    expect(await invokeAppCommand('window.spreadsheetSplit')).toBe(true);
    await browser.waitUntil(async () => (await getState()).splitMode === 'quad', {
      timeoutMsg: 'the command did not enter quad mode',
    });
    await $('[data-testid="quad-container"]').waitForDisplayed({ timeout: 10_000 });
  });

  after(async () => {
    if ((await getState()).splitMode === 'quad') await invokeAppCommand('window.spreadsheetSplit');
    await closeAllFiles();
    await clearViewHistory();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('after a divider drag, Fit Width and the grid keep the four panes aligned', async () => {
    await dragQuadDivider(
      'col',
      0.72,
      (q) => q.a.clientWidth > q.b.clientWidth * 1.8 && q.c.clientWidth > q.d.clientWidth * 1.8,
      'the column divider drag did not make the left panes wider',
    );
    await dragQuadDivider(
      'row',
      0.62,
      (q) => q.a.clientHeight > q.c.clientHeight * 1.3 && q.b.clientHeight > q.d.clientHeight * 1.3,
      'the row divider drag did not make the top panes taller',
    );
    await waitForQuad(
      (q) =>
        q.a.clientWidth > q.b.clientWidth * 1.8 &&
        q.c.clientWidth > q.d.clientWidth * 1.8 &&
        q.a.clientHeight > q.c.clientHeight * 1.3,
      'the divider drags did not leave the panes unequal',
    );

    expect(await invokeAppCommand('view.fitWidth')).toBe(true);
    await waitForQuad((q) => {
      const narrowest = Math.min(...PANES.map((p) => q[p].clientWidth));
      return PANES.every(
        (p) =>
          q[p].zoomMode === 'fitWidth' &&
          q[p].zoomPercent === q.a.zoomPercent &&
          q[p].cells.length > 0 &&
          Math.abs(q[p].cells[0].width - (narrowest - 16)) <= 3,
      );
    }, 'Fit Width did not size every pane to the narrowest pane');
    await scrollAndExpectAligned('a', 0.55, 'Fit Width');
    await scrollAndExpectAligned('c', 0.35, 'Fit Width');

    expect(await invokeAppCommand('view.multiPage')).toBe(true);
    await waitForQuad(
      (q) => PANES.every((p) => q[p].layoutMode === 'grid') && misalignment(q) === null,
      'the grid layout did not reach all four panes with one column count',
    );
    await scrollAndExpectAligned('a', 0.6, 'grid');
    await scrollAndExpectAligned('c', 0.4, 'grid');

    expect(await invokeAppCommand('view.singlePage')).toBe(true);
    await waitForQuad(
      (q) => PANES.every((p) => q[p].layoutMode === 'single'),
      'the single layout did not return to all four panes',
    );
  });

  it('a Ctrl+wheel or a zoom step in one pane rescales all four and keeps them aligned', async () => {
    expect(await invokeAppCommand('view.actualSize')).toBe(true);
    const start = await waitForQuad(
      (q) => PANES.every((p) => q[p].zoomMode === 'actual' && q[p].zoomPercent === q.a.zoomPercent),
      'Actual Size did not reach all four panes',
    );
    const box = await readingViewDom(PANE('a'));
    expect(box).not.toBeNull();
    const path = await readingWheel({
      x: box!.box.left + box!.box.width / 2,
      y: box!.box.top + box!.box.height / 2,
      deltaY: -100,
      modifier: 'ctrl',
      scope: PANE('a'),
    });
    console.log(`quad Ctrl+wheel delivered through the ${path} path`);
    const wheeled = await waitForQuad(
      (q) =>
        q.a.zoomPercent > start.a.zoomPercent &&
        PANES.every((p) => q[p].zoomMode === q.a.zoomMode && q[p].zoomPercent === q.a.zoomPercent) &&
        misalignment(q) === null,
      'Ctrl+wheel in pane a did not rescale all four panes in alignment',
    );
    await scrollAndExpectAligned('a', 0.55, 'Ctrl+wheel');

    expect(await invokeAppCommand('view.zoomIn')).toBe(true);
    await waitForQuad(
      (q) =>
        PANES.every((p) => q[p].zoomPercent > wheeled.a.zoomPercent && q[p].zoomPercent === q.a.zoomPercent) &&
        misalignment(q) === null,
      'a zoom step did not rescale all four panes in alignment',
    );
    await scrollAndExpectAligned('c', 0.35, 'zoom step');
  });
});
