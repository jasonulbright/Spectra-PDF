// Output Preview: the pages in view raster through the separation device
// instead of the viewer's own renderer.
//
// The assertions are about PIXELS and MEASUREMENTS, not about a panel
// rendering. No RGB device simulates overprint and none can show one plate,
// so a preview that merely put a label on the screen would be showing the
// same raster it always did — the separation canvas has to exist, its pixels
// have to change when an ink is switched off, and the total-ink figure has to
// match a page built to carry it.
//
// A soft proof is a rendering claim, so the same rule governs it: the medium
// has to change colour when it is simulated, and every proof control is read
// back from what the engine says it USED rather than from what the panel
// asked for — a request the engine refused must not be able to look honoured.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  closeAllFiles,
  invokeAppCommand,
  getFirstAnnotation,
  setReactSelectValue,
  fireReactSelectChange,
  answerIccPicker,
  iccPickerPending,
  preflightSnapshot,
  preflightSelectProfile,
  preflightImportProfile,
  preflightExportProfile,
  preflightFix,
  waitForDisplayedSelector,
} from '../support/harness.js';

const SPOT = resolve(__dirname, '..', 'fixtures', 'separations-spot.pdf');
const LADDER = resolve(__dirname, '..', 'fixtures', 'separations-tac.pdf');

/** The ladder's heaviest patch, by construction. */
const LADDER_MAX_TAC = 340;

const SIMULATION_SELECT = '[data-testid="output-preview-simulation"]';

/** Where the medium itself shows on the spot fixture: nothing is painted
 *  below a third of the page height, and the raster runs edge to edge. */
const PAPER_SAMPLE = { x: 0.5, y: 0.85 };

interface SeparationSample {
  found: boolean;
  sum: number;
  pixels: number;
  /** The composited colour of one point of unpainted medium. */
  paper: number[] | null;
}

/** A fingerprint of the separation canvas' pixels — enough to prove a
 *  re-composite changed the image without carrying the image around — and one
 *  point of medium read as a value. The canvas is sized to the engine's PNG
 *  and blitted 1:1, so a sample IS the composited pixel rather than a
 *  resampling of it. */
async function separationFingerprint(): Promise<SeparationSample> {
  return browser.execute(
    function (fx: number, fy: number) {
      const list = Array.prototype.slice.call(
        document.querySelectorAll('canvas.pageview-separation.ready'),
      ) as HTMLCanvasElement[];
      const drawn = list.filter((c) => c.width > 8 && c.height > 8);
      if (drawn.length === 0) return { found: false, sum: 0, pixels: 0, paper: null };
      const canvas = drawn[0];
      const ctx = canvas.getContext('2d');
      if (!ctx) return { found: false, sum: 0, pixels: 0, paper: null };
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      let pixels = 0;
      for (let i = 0; i < data.length; i += 4 * 37) {
        sum += data[i] + data[i + 1] + data[i + 2];
        pixels += 1;
      }
      const spot = ctx.getImageData(
        Math.floor(canvas.width * fx),
        Math.floor(canvas.height * fy),
        1,
        1,
      ).data;
      return { found: true, sum, pixels, paper: [spot[0], spot[1], spot[2]] };
    },
    PAPER_SAMPLE.x,
    PAPER_SAMPLE.y,
  );
}

async function waitForSeparations(timeout = 60_000): Promise<{ sum: number; pixels: number }> {
  let captured: SeparationSample = { found: false, sum: 0, pixels: 0, paper: null };
  await browser.waitUntil(
    async () => {
      captured = await separationFingerprint();
      return captured.found && captured.pixels > 0;
    },
    { timeout, timeoutMsg: 'the separation raster never replaced the page' },
  );
  return { sum: captured.sum, pixels: captured.pixels };
}

/**
 * Wait for the composite the predicate describes, and return what the
 * predicate itself saw. The value never comes from a second read: the canvas
 * re-blits on every re-composite, so a wait followed by a read is two moments
 * and the second one can already be a different image.
 */
async function waitForComposite(
  accepts: (sample: SeparationSample) => boolean,
  message: string,
  timeout = 90_000,
): Promise<SeparationSample> {
  let captured: SeparationSample = { found: false, sum: 0, pixels: 0, paper: null };
  await browser.waitUntil(
    async () => {
      const next = await separationFingerprint();
      if (!next.found || !accepts(next)) return false;
      captured = next;
      return true;
    },
    { timeout, timeoutMsg: message },
  );
  return captured;
}

/** Consecutive agreeing reads that count the composite as still, and how far
 *  apart they are taken. The span is several times the longest stall inside
 *  one re-composite, so an image mid-pipeline cannot look settled. */
const SETTLE_READS = 8;
const SETTLE_INTERVAL_MS = 250;

/**
 * The composite once it has STOPPED MOVING.
 *
 * A single read cannot tell the current composite from the previous one. The
 * panel's readout is live the moment the engine answers, while the canvas
 * re-blits on a debounce, so there is a window in which the controls describe
 * a proof whose pixels are not on screen yet — the raster still showing is the
 * one the previous state produced. A baseline taken from that window measures
 * a toggle against an image the toggle never touched, so anything that needs
 * "this IS the composite for the state the panel reports" waits here rather
 * than on the presence of a raster.
 */
async function waitForSettledComposite(
  message: string,
  timeout = 90_000,
): Promise<SeparationSample> {
  let held: SeparationSample | null = null;
  let agreements = 0;
  await browser.waitUntil(
    async () => {
      const next = await separationFingerprint();
      if (!next.found || next.pixels === 0) {
        held = null;
        agreements = 0;
        return false;
      }
      agreements = held !== null && next.sum === held.sum ? agreements + 1 : 0;
      held = next;
      return agreements >= SETTLE_READS;
    },
    { timeout, timeoutMsg: message, interval: SETTLE_INTERVAL_MS },
  );
  return held as unknown as SeparationSample;
}

interface SwitchState {
  checked: boolean;
  disabled: boolean;
}

interface ProofControls {
  /** What the panel is ASKING for. The select carries the request; every
   *  field below carries what the engine answered. */
  requested: string;
  /** The press profiles this document offers. */
  options: string[];
  /** The engine named a press it proofed through. */
  using: boolean;
  /** That line verbatim. The only thing that varies in it is the profile
   *  NAME the engine reports, so it is only ever compared against itself
   *  under another profile — the wording cancels. */
  usingText: string;
  /** The engine reported why it could not proof. */
  refused: boolean;
  forcedNote: boolean;
  paperWhite: SwitchState | null;
  blackInk: SwitchState | null;
  /** The heaviest pixel's total ink, as the panel prints it. */
  maxTacPct: number | null;
}

const NO_CONTROLS: ProofControls = {
  requested: '',
  options: [],
  using: false,
  usingText: '',
  refused: false,
  forcedNote: false,
  paperWhite: null,
  blackInk: null,
  maxTacPct: null,
};

async function proofControls(): Promise<ProofControls> {
  return browser.execute<ProofControls, []>(function () {
    const find = (id: string): Element | null =>
      document.querySelector('[data-testid="' + id + '"]');
    const box = (id: string): { checked: boolean; disabled: boolean } | null => {
      const el = find(id) as HTMLInputElement | null;
      return el ? { checked: el.checked, disabled: el.disabled } : null;
    };
    const select = find('output-preview-simulation') as HTMLSelectElement | null;
    const usingLine = find('output-preview-simulation-using');
    const tac = find('output-preview-maxtac');
    // The FIGURE, never the sentence around it: the wording is localized and
    // the number is not.
    const figure = tac ? /([\d.]+)\s*%/.exec(tac.textContent || '') : null;
    return {
      requested: select ? select.value : '',
      options: select
        ? (Array.prototype.slice.call(select.options) as HTMLOptionElement[]).map((o) => o.value)
        : [],
      using: usingLine !== null,
      usingText: usingLine ? usingLine.textContent || '' : '',
      refused: find('output-preview-simulation-off') !== null,
      forcedNote: find('output-preview-black-ink-forced') !== null,
      paperWhite: box('output-preview-paper-white'),
      blackInk: box('output-preview-black-ink'),
      maxTacPct: figure ? Number(figure[1]) : null,
    };
  });
}

/** The proof controls once they describe what the predicate asked for,
 *  returned from the predicate's own read for the reason `waitForComposite`
 *  states. */
async function proofSettled(
  accepts: (controls: ProofControls) => boolean,
  message: string,
  timeout = 90_000,
): Promise<ProofControls> {
  let captured: ProofControls = NO_CONTROLS;
  await browser.waitUntil(
    async () => {
      const next = await proofControls();
      if (!accepts(next)) return false;
      captured = next;
      return true;
    },
    { timeout, timeoutMsg: message },
  );
  return captured;
}

/** The spot fixture's `/Separation` patch at full tint, as a fraction of the
 *  page: `10 200 160 50 re` on a 400 pt square, sampled at its middle. */
const SPOT_PATCH = { u: (10 + 160 / 2) / 400, v: 1 - (200 + 50 / 2) / 400 };
/** Its cyan patch, `10 340 80 50 re`. */
const CYAN_PATCH = { u: (10 + 80 / 2) / 400, v: 1 - (340 + 50 / 2) / 400 };

interface Readout {
  present: boolean;
  nothing: boolean;
  kind: string;
  space: string;
  colorant: string;
  components: string;
  resolution: string;
  total: number | null;
  spotInk: number | null;
}

const NO_READOUT: Readout = {
  present: false, nothing: false, kind: '', space: '', colorant: '',
  components: '', resolution: '', total: null, spotInk: null,
};

/** What the panel's inspector section currently prints. */
async function readout(): Promise<Readout> {
  return browser.execute(function () {
    const find = (id: string): Element | null =>
      document.querySelector('[data-testid="' + id + '"]');
    const text = (id: string): string => (find(id)?.textContent || '').trim();
    const pct = (id: string): number | null => {
      const match = /([\d.]+)\s*%/.exec(text(id));
      return match ? parseFloat(match[1]) : null;
    };
    return {
      present: find('output-preview-inspect-top') !== null,
      nothing: find('output-preview-inspect-nothing') !== null,
      kind: text('output-preview-inspect-kind'),
      space: text('output-preview-inspect-space'),
      colorant: text('output-preview-inspect-colorant'),
      components: text('output-preview-inspect-components'),
      resolution: text('output-preview-inspect-resolution'),
      total: pct('output-preview-inspect-ink-total'),
      spotInk: pct('output-preview-inspect-ink-pantone-185-c'),
    };
  });
}

/** Where the first page cell sits on screen. */
async function pageBox(): Promise<{ x: number; y: number; w: number; h: number }> {
  return browser.execute(function () {
    const el = document.querySelector('[data-page-id]');
    if (!el) return { x: 0, y: 0, w: 0, h: 0 };
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
}

/**
 * The viewport point a fraction of the page cell sits at, scrolled into reach
 * and measured from the read that proved it had stopped moving.
 *
 * A page taller than the reading column puts its lower part below the fold,
 * and a pointer action refuses a move outside the viewport outright — so the
 * column is scrolled until the point is inside it. The coordinate comes from
 * the same read that hit-tested it, never from a second one: the column is
 * virtualized and repositions its rows, so a coordinate measured before that
 * lands names a place the page has since left.
 */
async function reachablePointOnPage(u: number, v: number): Promise<{ x: number; y: number }> {
  let held = { x: 0, y: 0 };
  let previous: string | null = null;
  await browser.waitUntil(
    async () => {
      const now = await browser.execute(
        function (fu: number, fv: number) {
          const cell = document.querySelector('[data-page-id]') as HTMLElement | null;
          const column = document.querySelector(
            '[data-testid="document-view"]',
          ) as HTMLElement | null;
          if (!cell || !column) return { x: 0, y: 0, key: '', onPage: false };
          const point = (): { x: number; y: number } => {
            const r = cell.getBoundingClientRect();
            return { x: r.left + r.width * fu, y: r.top + r.height * fv };
          };
          // `clientHeight`, not the bounding box: the column carries a
          // horizontal scrollbar, and the strip it occupies is inside the box
          // but not over the page.
          const margin = 8;
          const top = column.getBoundingClientRect().top + margin;
          const bottom = column.getBoundingClientRect().top + column.clientHeight - margin;
          const wanted = point();
          if (wanted.y > bottom) column.scrollTop += wanted.y - bottom;
          else if (wanted.y < top) column.scrollTop -= top - wanted.y;
          const now = point();
          const x = Math.round(now.x);
          const y = Math.round(now.y);
          const cellBox = cell.getBoundingClientRect();
          return {
            x,
            y,
            key: `${cellBox.left},${cellBox.top},${cellBox.width},${cellBox.height}`,
            // Reachable AND over the page: a coordinate the pointer can be
            // moved to is not yet a coordinate the page's own handler sees.
            onPage:
              x >= 0 &&
              y >= 0 &&
              x < window.innerWidth &&
              y < window.innerHeight &&
              cell.contains(document.elementFromPoint(x, y)),
          };
        },
        u,
        v,
      );
      const settled = previous === now.key;
      previous = now.key;
      held = { x: now.x, y: now.y };
      return settled && now.onPage;
    },
    {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: `the page never brought the point at (${u}, ${v}) into reach`,
    },
  );
  return held;
}

/** A real press and release on the page, at a fraction of the cell. The
 *  gesture goes through the canvas' own handlers rather than a test handle:
 *  what is under test is the routing, and a handle would bypass it. */
async function clickPageAt(u: number, v: number): Promise<void> {
  const at = await reachablePointOnPage(u, v);
  await browser
    .action('pointer')
    .move({ x: at.x, y: at.y, duration: 0 })
    .down()
    .pause(30)
    .up()
    .perform();
}

/** A drag across the page — the gesture that must pan and never mark. */
async function dragAcrossPage(): Promise<void> {
  const box = await pageBox();
  await browser
    .action('pointer')
    .move({ x: Math.round(box.x + box.w * 0.3), y: Math.round(box.y + box.h * 0.6), duration: 0 })
    .down()
    .move({ x: Math.round(box.x + box.w * 0.7), y: Math.round(box.y + box.h * 0.7), duration: 120 })
    .up()
    .perform();
}

async function waitForReadout(
  accept: (r: Readout) => boolean,
  message: string,
  timeout = 90_000,
): Promise<Readout> {
  let held: Readout = NO_READOUT;
  await browser.waitUntil(
    async () => {
      held = await readout();
      return accept(held);
    },
    { timeout, timeoutMsg: message, interval: 300 },
  );
  return held;
}

async function openOutputPreview(): Promise<void> {
  // The panel lives in the dock BESIDE the document — the preview replaces
  // the page raster, so the page has to stay on screen.
  await setView('operations');
  await invokeAppCommand('view.documentView');
  await waitForDisplayedSelector('[data-testid="document-view"]', { timeout: 15_000 });
  await setActiveOp('outputpreview');
  await waitForDisplayedSelector('[data-testid="output-preview-arm"]', { timeout: 15_000 });
}

describe('output preview', () => {
  before(async () => {
    await waitForHarness();
  });

  after(async () => {
    await closeAllFiles();
  });

  it('arming replaces the page raster with the separation composite', async () => {
    await closeAllFiles();
    await openByPaths([SPOT]);
    await openOutputPreview();

    // Nothing stands in for the viewer's raster until the mode is armed.
    expect((await separationFingerprint()).found).toBe(false);

    await $('[data-testid="output-preview-arm"]').click();
    const armed = await waitForSeparations();
    expect(armed.pixels).toBeGreaterThan(0);
    expect(await $('[data-testid="output-preview-arm"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('lists the plates the page actually separated into', async () => {
    await waitForDisplayedSelector('[data-testid="output-preview-ink-list"]', { timeout: 20_000 });
    for (const slug of ['cyan', 'magenta', 'yellow', 'black']) {
      await waitForDisplayedSelector(`[data-testid="output-preview-ink-${slug}"]`, {
        timeout: 20_000,
      });
    }
    // The fixture's spot colorant gets a plate of its own, which is the whole
    // reason the preview exists — an RGB render folds it into process.
    await waitForDisplayedSelector('[data-testid="output-preview-ink-pantone-185-c"]', {
      timeout: 20_000,
    });
  });

  it('reads the per-ink page coverage the device measured', async () => {
    const coverage = await $('[data-testid="output-preview-coverage-cyan"]').getText();
    expect(coverage).toMatch(/\d/);
  });

  it('switching an ink off changes the page', async () => {
    const before = await waitForSeparations();
    await $('[data-testid="output-preview-toggle-pantone-185-c"]').click();
    let after = before;
    await browser.waitUntil(
      async () => {
        const next = await separationFingerprint();
        if (!next.found) return false;
        after = { sum: next.sum, pixels: next.pixels };
        return next.sum !== before.sum;
      },
      { timeout: 60_000, timeoutMsg: 'switching an ink off never re-composited the page' },
    );
    // Removing an ink can only ever lighten the page.
    expect(after.sum).toBeGreaterThan(before.sum);
    await $('[data-testid="output-preview-toggle-pantone-185-c"]').click();
  });

  it('flipping overprint simulation re-renders through the device', async () => {
    const before = await waitForSeparations();
    await $('[data-testid="output-preview-overprint"]').click();
    await browser.waitUntil(
      async () => {
        const next = await separationFingerprint();
        return next.found && next.pixels > 0;
      },
      { timeout: 90_000, timeoutMsg: 'disabling overprint never produced a raster' },
    );
    expect(before.pixels).toBeGreaterThan(0);
    await $('[data-testid="output-preview-overprint"]').click();
  });

  it('the ink limit alarm measures the heaviest pixel, not the page average', async () => {
    await closeAllFiles();
    await openByPaths([LADDER]);
    await openOutputPreview();
    await $('[data-testid="output-preview-arm"]').click();
    await waitForSeparations();

    await $('[data-testid="output-preview-alarm"]').click();
    await waitForDisplayedSelector('[data-testid="output-preview-maxtac"]', { timeout: 30_000 });

    let reported = 0;
    await browser.waitUntil(
      async () => {
        const text = await $('[data-testid="output-preview-maxtac"]').getText();
        const match = /([\d.]+)\s*%/.exec(text);
        if (!match) return false;
        reported = Number(match[1]);
        return reported > 0;
      },
      { timeout: 30_000, timeoutMsg: 'the heaviest-pixel figure never appeared' },
    );
    // The ladder's heaviest patch is 340 % by construction. The device's own
    // page average over the same page is 200 %, which is why the alarm cannot
    // be driven by it.
    expect(reported).toBeGreaterThan(LADDER_MAX_TAC - 5);
    expect(reported).toBeLessThan(LADDER_MAX_TAC + 5);

    const over = await $('[data-testid="output-preview-over"]').getText();
    expect(over).toMatch(/\d/);
  });

  it('leaving the mode gives the ordinary raster back', async () => {
    await $('[data-testid="output-preview-arm"]').click();
    await browser.waitUntil(
      async () => !(await separationFingerprint()).found,
      { timeout: 30_000, timeoutMsg: 'the separation raster outlived the mode' },
    );
    expect(await $('[data-testid="output-preview-arm"]').getAttribute('aria-pressed')).toBe('false');
    // The viewer's own raster was never overwritten, so it is still there.
    const base = await browser.execute(function () {
      const list = Array.prototype.slice.call(
        document.querySelectorAll('canvas.pageview-base'),
      ) as HTMLCanvasElement[];
      return list.filter((c) => c.width > 8 && c.height > 8).length;
    });
    expect(base).toBeGreaterThan(0);
  });

  it('opening another tool disarms the preview', async () => {
    await setActiveOp('outputpreview');
    await $('[data-testid="output-preview-arm"]').click();
    await waitForSeparations();
    expect(await invokeAppCommand('tools.open.protect')).toBe(true);
    await browser.waitUntil(
      async () => !(await separationFingerprint()).found,
      { timeout: 30_000, timeoutMsg: 'a closed tool left the preview armed' },
    );
  });

  describe('the soft proof', () => {
    before(async () => {
      await closeAllFiles();
      await openByPaths([SPOT]);
      await openOutputPreview();
      await $('[data-testid="output-preview-arm"]').click();
      await waitForSeparations();
    });

    it('opens unproofed on a document that declares no press', async () => {
      // The bundled press being on offer is what proves the engine answered:
      // without it, an unproofed panel is only the state it started in.
      const idle = await proofSettled(
        (c) => c.options.indexOf('bundled') >= 0,
        'the press profiles never reached the panel',
      );
      expect(idle.options).not.toContain('document');
      // Offered, never assumed — a proof against a press neither the user
      // chose nor the document declared is a claim about nobody's press.
      expect(idle.requested).toBe('none');
      expect(idle.using).toBe(false);
      expect(idle.refused).toBe(false);
      // Nothing to simulate the paper white OF.
      expect(idle.paperWhite).toEqual({ checked: false, disabled: true });
      expect(idle.blackInk).toEqual({ checked: false, disabled: true });
    });

    it('proofing through a press moves the composite off the ink model', async () => {
      const before = await waitForComposite(
        (s) => s.pixels > 0,
        'the unproofed composite never settled',
      );
      expect(before.paper).toEqual([255, 255, 255]);

      await setReactSelectValue(SIMULATION_SELECT, 'bundled');
      const live = await proofSettled(
        (c) => c.requested === 'bundled' && c.using,
        'the bundled press never became the proof',
      );
      expect(live.refused).toBe(false);
      expect(live.paperWhite?.disabled).toBe(false);
      expect(live.blackInk?.disabled).toBe(false);

      // A proof that rendered the same image as the ink model would not be a
      // proof: the multiply model puts solid CMY at black and no press does.
      const proofed = await waitForComposite(
        (s) => s.sum !== before.sum,
        'choosing a press never re-composited the page',
      );
      // Relative colorimetric maps the profile's media white onto the
      // display's, so the medium alone is untouched while the ink moves.
      expect(proofed.paper).toEqual([255, 255, 255]);
    });

    it('simulating paper white holds the medium and forces the black ink', async () => {
      await $('[data-testid="output-preview-black-ink"]').click();
      const chosen = await proofSettled(
        (c) => c.blackInk?.checked === true,
        'the black-ink switch never took the choice',
      );
      expect(chosen.blackInk?.disabled).toBe(false);
      expect(chosen.forcedNote).toBe(false);

      await $('[data-testid="output-preview-paper-white"]').click();
      // Both halves come from the engine's answer, so waiting on the pair
      // cannot capture the click's own optimistic state.
      const forced = await proofSettled(
        (c) => c.paperWhite?.checked === true && c.blackInk?.disabled === true,
        'simulating paper white never took',
      );
      // Absolute colorimetric already carries both endpoints of the medium,
      // so compensation changes nothing under it: the switch is held on and
      // taken out of the user's hands rather than left doing nothing.
      expect(forced.blackInk).toEqual({ checked: true, disabled: true });
      expect(forced.forcedNote).toBe(true);

      const dimmed = await waitForComposite(
        (s) => s.paper !== null && s.paper[0] < 255,
        'the medium never took the profile’s own white',
      );
      const paper = dimmed.paper as number[];
      // The profile's paper is dim and slightly warm, and it is paper rather
      // than shadow: every channel moves, none collapses.
      expect(paper[1]).toBeLessThan(255);
      expect(paper[2]).toBeLessThan(255);
      expect(paper[0]).toBeGreaterThan(180);
      expect(paper[0]).toBeGreaterThan(paper[2]);
    });

    it('turning paper white off gives the black-ink choice back', async () => {
      await $('[data-testid="output-preview-paper-white"]').click();
      const released = await proofSettled(
        (c) => c.paperWhite?.checked === false && c.blackInk?.disabled === false,
        'the black-ink switch never came back',
      );
      // Remembered, not reset: a forced state must not overwrite a choice.
      expect(released.blackInk?.checked).toBe(true);
      expect(released.forcedNote).toBe(false);

      const back = await waitForComposite(
        (s) => s.paper !== null && s.paper[0] === 255,
        'the medium never returned to display white',
      );
      expect(back.paper).toEqual([255, 255, 255]);
    });

    it('measures the same ink on the sheet with a proof and without one', async () => {
      // No display transform changes how much ink is on the sheet, so the
      // figures are a property of the page and not of the press.
      const proofed = await proofSettled(
        (c) => c.using && c.maxTacPct !== null,
        'the proofed total-ink figure never appeared',
      );
      await setReactSelectValue(SIMULATION_SELECT, 'none');
      const plain = await proofSettled(
        (c) => c.requested === 'none' && !c.using && c.maxTacPct !== null,
        'the unproofed total-ink figure never came back',
      );
      expect(plain.maxTacPct).toBe(proofed.maxTacPct);

      await setReactSelectValue(SIMULATION_SELECT, 'bundled');
      await proofSettled((c) => c.using, 'the proof never came back');
    });

    it('switches a plate off under an active proof', async () => {
      // The baseline is the proofed composite ITSELF, not whatever raster is
      // on screen: the press was chosen in an earlier case, and a raster left
      // over from before that choice would make the first change this test
      // sees the proof arriving rather than the plate going away.
      const before = await waitForSettledComposite(
        'the proofed composite never settled',
      );
      await $('[data-testid="output-preview-toggle-pantone-185-c"]').click();
      // A hidden plate contributes no coverage, so the transform sees a page
      // that ink never printed on — which can only lighten it.
      const after = await waitForComposite(
        (s) => s.sum !== before.sum,
        'switching an ink off under a proof never re-composited the page',
      );
      expect(after.sum).toBeGreaterThan(before.sum);
      await $('[data-testid="output-preview-toggle-pantone-185-c"]').click();
      // Exactly the image the ink was removed from. A composite is a function
      // of the plates it draws, so anything else means the plate came back as
      // something other than what left.
      await waitForComposite(
        (s) => s.sum === before.sum,
        'the ink never came back',
      );
    });

    it('reports a refused proof and shows nothing proofed', async () => {
      // Nothing is left for a press profile to describe once no process
      // plate is showing.
      for (const slug of ['cyan', 'magenta', 'yellow', 'black']) {
        await $(`[data-testid="output-preview-toggle-${slug}"]`).click();
      }
      const refused = await proofSettled(
        (c) => c.refused,
        'the refusal never reached the panel',
      );
      // The request is still visibly the bundled press, and every control
      // still reads from the answer — so the fallback cannot look honoured.
      expect(refused.requested).toBe('bundled');
      expect(refused.using).toBe(false);
      expect(refused.paperWhite).toEqual({ checked: false, disabled: true });
      expect(refused.blackInk).toEqual({ checked: false, disabled: true });

      await $('[data-testid="output-preview-show-all"]').click();
      await proofSettled((c) => c.using, 'the proof never came back');
    });
  });

  describe('a press profile picked from a file', () => {
    let dir = '';

    /**
     * A CMYK press profile that is NOT the one bundled with the engine.
     *
     * The pick is only proven honoured by an image the bundled press cannot
     * produce, so the two profiles have to differ — proofing through a copy
     * of the bundled press would composite to the same pixels whether the
     * picked path reached the engine or not.
     */
    const PICKED_PRESS = resolve(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'spool', 'drivers', 'color', 'RSWOP.icm',
    );

    before(async () => {
      expect(existsSync(PICKED_PRESS)).toBe(true);
      dir = mkdtempSync(resolve(tmpdir(), 'spectra-pick-'));
      await closeAllFiles();
      await openByPaths([SPOT]);
      await openOutputPreview();
      await $('[data-testid="output-preview-arm"]').click();
      await waitForSeparations();
    });

    after(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('proofs through the profile the picker returned', async () => {
      const plain = await waitForSettledComposite('the unproofed composite never settled');

      await setReactSelectValue(SIMULATION_SELECT, 'bundled');
      const press = await proofSettled(
        (c) => c.requested === 'bundled' && c.using,
        'the bundled press never became the proof',
      );
      await waitForComposite(
        (s) => s.sum !== plain.sum,
        'the bundled press never re-composited the page',
      );
      const bundled = await waitForSettledComposite('the bundled proof never settled');

      await answerIccPicker(PICKED_PRESS);
      await setReactSelectValue(SIMULATION_SELECT, 'file');

      // A request that reached the engine without the path could not proof at
      // all, and one that quietly fell back to the bundled press would
      // composite to the image already measured — so these pixels are the
      // picked profile's own. This is also what says the engine has ANSWERED
      // the pick: the source flips as soon as the picker returns, while the
      // record beside it is still the previous press's until the round trip
      // lands, so a control read taken before this one reads the old proof.
      const proofed = await waitForComposite(
        (s) => s.sum !== bundled.sum,
        'the picked profile never re-composited the page',
      );
      expect(proofed.pixels).toBeGreaterThan(0);

      // The select renders the source the preview HOLDS, so `file` here is
      // the transition the picker's answer drove rather than the click that
      // opened it.
      const live = await proofSettled(
        (c) => c.requested === 'file' && c.using,
        'the picked profile never became the proof',
      );
      expect(live.refused).toBe(false);
      expect(live.paperWhite?.disabled).toBe(false);
      expect(live.blackInk?.disabled).toBe(false);
      // The engine names the profile it loaded, and the pick is the only
      // thing that changed.
      expect(live.usingText).not.toBe(press.usingText);
    });

    it('refuses a picked file that is not a press profile', async () => {
      const bogus = resolve(dir, 'not-a-profile.icc');
      writeFileSync(bogus, 'this is not a colour profile');

      await answerIccPicker(bogus);
      await setReactSelectValue(SIMULATION_SELECT, 'file');

      // The previous pick is still the path the preview holds, so a request
      // that dropped this one would go on proofing through it — only the
      // bytes at the picked path refuse.
      const refused = await proofSettled(
        (c) => c.requested === 'file' && c.refused,
        'the picked file never refused',
      );
      expect(refused.using).toBe(false);
      expect(refused.paperWhite).toEqual({ checked: false, disabled: true });
      expect(refused.blackInk).toEqual({ checked: false, disabled: true });
    });

    it('leaves the proof alone when the pick is cancelled', async () => {
      const refused = await waitForSettledComposite('the refused composite never settled');
      await setReactSelectValue(SIMULATION_SELECT, 'bundled');
      const press = await proofSettled(
        (c) => c.requested === 'bundled' && c.using,
        'the bundled press never came back',
      );
      await waitForComposite(
        (s) => s.sum !== refused.sum,
        'the bundled press never re-composited the page',
      );
      const bundled = await waitForSettledComposite('the bundled proof never settled');

      await answerIccPicker(null);
      // The option that opens the picker leaves the source alone when the
      // dialog comes back empty, so the control snaps straight back and there
      // is nothing to wait for on it — the pick itself is the evidence, and
      // the answer being taken is what says it happened.
      await fireReactSelectChange(SIMULATION_SELECT, 'file');
      await browser.waitUntil(async () => !(await iccPickerPending()), {
        timeout: 30_000,
        timeoutMsg: 'the profile picker never opened',
      });

      // A cancelled pick changes nothing, so nothing re-composites on its own
      // and an image that never moved would prove nothing. Switching a plate
      // off and back on forces a round trip through whatever request the
      // preview now holds: the path it still carries is the unreadable one,
      // so a source that had moved to `file` would come back refused.
      await $('[data-testid="output-preview-toggle-pantone-185-c"]').click();
      await waitForComposite(
        (s) => s.sum !== bundled.sum,
        'switching an ink off never re-composited the page',
      );
      await $('[data-testid="output-preview-toggle-pantone-185-c"]').click();
      const back = await waitForComposite(
        (s) => s.sum === bundled.sum,
        'a cancelled pick changed what the page proofs through',
      );
      expect(back.pixels).toBeGreaterThan(0);

      const held = await proofSettled(
        (c) => c.requested === 'bundled' && c.using,
        'a cancelled pick moved the source off the press it was on',
      );
      expect(held.refused).toBe(false);
      expect(held.usingText).toBe(press.usingText);
    });
  });

  describe('the output intent a document carries', () => {
    let dir = '';

    before(() => {
      dir = mkdtempSync(resolve(tmpdir(), 'spectra-proof-'));
    });

    after(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    /**
     * Give the open document an output intent, through the repair that owns
     * that edit. The rule is authored here rather than taken from a shipped
     * one so the spec owns the only thing it varies: with `embed` the intent
     * carries the press profile, and without it the intent names a condition
     * and embeds nothing — two documents, and two different answers.
     */
    async function giveOutputIntent(id: string, embed: boolean): Promise<void> {
      await setView('canvas');
      expect(await invokeAppCommand('tools.panel.preflight')).toBe(true);
      await browser.waitUntil(async () => (await preflightSnapshot()) !== null, {
        timeout: 60_000,
        timeoutMsg: 'the preflight report never arrived',
      });
      await preflightSelectProfile('pdfx_3');
      await browser.waitUntil(async () => (await preflightSnapshot())?.profile === 'pdfx_3', {
        timeout: 60_000,
        timeoutMsg: 'the exchange profile never took',
      });

      const target = resolve(dir, `${id}.json`);
      expect(await preflightExportProfile(target)).not.toContain('__SPECTRA_E2E_ERROR__');
      const doc = JSON.parse(readFileSync(target, 'utf8'));
      doc.profile.id = id;
      doc.profile.name = id;
      doc.profile.fixups = [
        {
          id: 'convert_to_pdfx',
          params: embed ? { version: 3, dest_profile: 'default_cmyk.icc' } : { version: 3 },
        },
      ];
      writeFileSync(target, JSON.stringify(doc, null, 2));
      expect(await preflightImportProfile(target)).toBe(id);
      await browser.waitUntil(async () => (await preflightSnapshot())?.profile === id, {
        timeout: 60_000,
        timeoutMsg: 'the authored rule never took',
      });

      expect(await preflightFix('output_intent')).toBe(true);
    }

    it('offers an intent that embeds no profile, and refuses it by name', async () => {
      await closeAllFiles();
      await openByPaths([SPOT]);
      await giveOutputIntent('intent_named_only', false);
      await openOutputPreview();
      await $('[data-testid="output-preview-arm"]').click();
      await waitForSeparations();

      const opened = await proofSettled(
        (c) => c.options.indexOf('document') >= 0,
        'the document’s own intent never reached the panel',
      );
      // A condition this engine holds no profile for is named, not proofed
      // against: substituting another press would proof against one document
      // while displaying another's condition.
      expect(opened.requested).toBe('none');
      expect(opened.using).toBe(false);

      await setReactSelectValue(SIMULATION_SELECT, 'document');
      const refused = await proofSettled(
        (c) => c.requested === 'document' && c.refused,
        'choosing an intent that embeds nothing never refused',
      );
      expect(refused.using).toBe(false);
      expect(refused.paperWhite).toEqual({ checked: false, disabled: true });
      expect(refused.blackInk).toEqual({ checked: false, disabled: true });
    });

    it('opens proofing through an intent that embeds its profile', async () => {
      await closeAllFiles();
      await openByPaths([SPOT]);
      await giveOutputIntent('intent_embedded', true);
      await browser.waitUntil(
        async () =>
          (await preflightSnapshot())?.checks.find((c) => c.id === 'output_intent')?.status ===
          'pass',
        { timeout: 120_000, timeoutMsg: 'the document never took an embedded intent' },
      );

      await openOutputPreview();
      await $('[data-testid="output-preview-arm"]').click();
      await waitForSeparations();

      const opened = await proofSettled(
        (c) => c.options.indexOf('document') >= 0 && c.using,
        'the document’s own press never became the proof',
      );
      // The document's own press outranks every other source, so the panel
      // opens on it rather than unproofed.
      expect(opened.requested).toBe('document');
      expect(opened.refused).toBe(false);
      expect(opened.paperWhite?.disabled).toBe(false);
      expect(opened.blackInk?.disabled).toBe(false);
    });
  });

  describe('the point inspector', () => {
    before(async () => {
      await closeAllFiles();
      await openByPaths([SPOT]);
      await openOutputPreview();
      await $('[data-testid="output-preview-arm"]').click();
      // The readout goes live the moment the engine answers while the canvas
      // re-blits on a debounce, so "a raster is present" is not "this state's
      // raster is present" — the click has to land on the settled composite.
      await waitForSettledComposite('the composite never settled for a click');
    });

    it('says nothing has been asked until the page is clicked', async () => {
      const idle = await readout();
      expect(idle.present).toBe(false);
      expect(await $('[data-testid="output-preview-inspect-hint"]').isExisting()).toBe(true);
    });

    it('names the object under the point, in the space the document declares', async () => {
      await clickPageAt(SPOT_PATCH.u, SPOT_PATCH.v);
      const spot = await waitForReadout(
        (r) => r.present,
        'clicking the spot patch never produced a readout',
      );
      // The colorant name is document content and is shown verbatim; the
      // space is what the file DECLARES, not what a renderer made of it.
      expect(spot.space).toContain('Separation');
      expect(spot.colorant).toContain('PANTONE 185 C');
      expect(spot.kind).not.toBe('');
      // A filled path is not a raster, and that is an answer rather than a
      // blank row or a zero.
      expect(spot.resolution).not.toBe('');
    });

    it('reads the ink off the plates at that pixel', async () => {
      const spot = await waitForReadout(
        (r) => r.total !== null,
        'the ink row never printed',
      );
      // The patch is the spot at full tint: its own plate carries it whole
      // and nothing else on the sheet does.
      expect(spot.spotInk).toBeGreaterThan(95);
      expect(spot.total).toBeGreaterThan(95);
    });

    it('reports a process patch in its own device space', async () => {
      await clickPageAt(CYAN_PATCH.u, CYAN_PATCH.v);
      const cyan = await waitForReadout(
        (r) => r.present && r.space.indexOf('DeviceCMYK') >= 0,
        'clicking the cyan patch never named a device space',
      );
      expect(cyan.components).toMatch(/1/);
      expect(cyan.total).toBeGreaterThan(95);
    });

    it('says nothing is painted over blank medium, and still prints the ink', async () => {
      await clickPageAt(PAPER_SAMPLE.x, PAPER_SAMPLE.y);
      const paper = await waitForReadout(
        (r) => r.nothing,
        'clicking blank medium never reported an empty point',
      );
      // An answer, not an empty panel: the ink row is exact over paper.
      expect(paper.present).toBe(false);
      expect(paper.total).toBe(0);
    });

    it('drops the readout when the plates it was measured against are retired', async () => {
      await $('[data-testid="output-preview-overprint"]').click();
      await browser.waitUntil(async () => !(await readout()).present && !(await readout()).nothing, {
        timeout: 60_000,
        timeoutMsg: 'a re-raster left the previous point’s answer on screen',
      });
      await $('[data-testid="output-preview-overprint"]').click();
      await waitForSettledComposite('the composite never settled after the overprint flip');
    });

    it('a drag under the mode still pans and marks nothing', async () => {
      // The other side of the exclusion the canvas comment guards: this mode
      // claims a CLICK and never a drag, so the band stays unreachable and no
      // annotation can be committed by moving the pointer over the page.
      const before = await getFirstAnnotation(1_000);
      expect(before).toBeNull();
      await dragAcrossPage();
      await browser.pause(500);
      expect(await getFirstAnnotation(1_000)).toBeNull();
      // A drag is not a query either — the click a completed pan still fires
      // must not be read as one.
      expect((await readout()).present).toBe(false);
    });

    it('leaving the mode drops the readout', async () => {
      await $('[data-testid="output-preview-arm"]').click();
      await browser.waitUntil(
        async () => {
          const gone = await readout();
          return !gone.present && !gone.nothing;
        },
        { timeout: 30_000, timeoutMsg: 'disarming left a point readout on screen' },
      );
    });
  });
});
